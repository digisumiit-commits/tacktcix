"""Encrypted secrets store using AES-256-GCM.

Secrets are never persisted unencrypted. At runtime they are decrypted into
a tmpfs mount and never exposed in environment variables or logs.
"""

import base64
import hashlib
import hmac
import json
import os
import secrets as _secrets
import struct
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class SecretClass(Enum):
    API_KEY = "api_key"
    DATABASE_CRED = "database_cred"
    TLS_CERT = "tls_cert"
    OAUTH_TOKEN = "oauth_token"
    SIGNING_KEY = "signing_key"
    GENERIC = "generic"


@dataclass
class SecretAccess:
    secret_id: str
    secret_class: SecretClass
    accessed_by: str
    timestamp: float = field(default_factory=time.time)
    trace_id: Optional[str] = None


@dataclass
class EncryptedSecret:
    id: str
    name: str
    secret_class: SecretClass
    ciphertext: bytes
    nonce: bytes
    created_at: float
    rotated_at: float
    expires_at: Optional[float]
    metadata: dict[str, Any]
    version: int = 1

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "secret_class": self.secret_class.value,
            "ciphertext": base64.b64encode(self.ciphertext).decode(),
            "nonce": base64.b64encode(self.nonce).decode(),
            "created_at": self.created_at,
            "rotated_at": self.rotated_at,
            "expires_at": self.expires_at,
            "metadata": self.metadata,
            "version": self.version,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "EncryptedSecret":
        return cls(
            id=data["id"],
            name=data["name"],
            secret_class=SecretClass(data["secret_class"]),
            ciphertext=base64.b64decode(data["ciphertext"]),
            nonce=base64.b64decode(data["nonce"]),
            created_at=data["created_at"],
            rotated_at=data.get("rotated_at", data["created_at"]),
            expires_at=data.get("expires_at"),
            metadata=data.get("metadata", {}),
            version=data.get("version", 1),
        )


class EncryptedSecretsStore:
    """AES-256-GCM encrypted secrets store.

    Secrets are stored encrypted on disk and only decrypted on demand.
    Decrypted values are written to a tmpfs mount, never to persistent storage.
    Environment variable injection is disabled by default (must explicitly opt in).
    """

    def __init__(
        self,
        storage_path: str,
        tmpfs_mount: str = "/secrets",
        key_source: str = "local",
        key_file: Optional[str] = None,
        vault_url: Optional[str] = None,
        vault_key_name: Optional[str] = None,
        rotation_days: int = 30,
        redacted_keys: Optional[set[str]] = None,
    ):
        self.storage_path = Path(storage_path)
        self.tmpfs_mount = Path(tmpfs_mount)
        self.key_source = key_source
        self.key_file = key_file
        self.vault_url = vault_url
        self.vault_key_name = vault_key_name
        self.rotation_days = rotation_days
        self.redacted_keys = redacted_keys or {
            "api_key", "password", "secret", "token", "private_key", "credential"
        }

        self._key: Optional[bytes] = None
        self._access_log: list[SecretAccess] = []

        os.makedirs(self.storage_path, mode=0o700, exist_ok=True)
        os.makedirs(self.tmpfs_mount, mode=0o700, exist_ok=True)

    def _derive_key(self, master_key: bytes, secret_id: str) -> bytes:
        return hashlib.sha256(master_key + secret_id.encode() + b"paperclip-secrets-v1").digest()

    def _get_master_key(self) -> bytes:
        if self._key is not None:
            return self._key

        if self.key_source == "local":
            if not self.key_file:
                raise ValueError("key_file required for local key source")
            with open(self.key_file, "rb") as f:
                key_data = f.read().strip()
            self._key = base64.b64decode(key_data)
        elif self.key_source == "vault":
            import httpx

            resp = httpx.get(
                f"{self.vault_url}/v1/transit/export/encryption-key/{self.vault_key_name}",
                headers={"X-Vault-Token": os.environ["VAULT_TOKEN"]},
                timeout=10,
            )
            resp.raise_for_status()
            key_b64 = resp.json()["data"]["keys"]["1"]["key"]
            self._key = base64.b64decode(key_b64)
        elif self.key_source == "env":
            key_b64 = os.environ.get("PAPERCLIP_MASTER_KEY", "")
            if not key_b64:
                raise ValueError("PAPERCLIP_MASTER_KEY not set for env key source")
            self._key = base64.b64decode(key_b64)
        else:
            raise ValueError(f"Unsupported key source: {self.key_source}")

        return self._key

    def _generate_id(self) -> str:
        return _secrets.token_hex(16)

    def _secret_file_path(self, secret_id: str) -> Path:
        return self.storage_path / f"{secret_id}.enc"

    def _redact_value(self, key: str, value: Any) -> Any:
        key_lower = key.lower()
        for redacted in self.redacted_keys:
            if redacted in key_lower:
                return "[REDACTED]"
        return value

    def _log_access(self, secret_id: str, secret_class: SecretClass, actor: str, trace_id: Optional[str] = None):
        self._access_log.append(
            SecretAccess(
                secret_id=secret_id,
                secret_class=secret_class,
                accessed_by=actor,
                trace_id=trace_id,
            )
        )

    # --- Public API ---

    def store(self, name: str, value: str, secret_class: SecretClass, actor: str,
              expires_in_days: Optional[int] = None, metadata: Optional[dict] = None,
              trace_id: Optional[str] = None) -> str:
        """Encrypt and store a secret. Returns the secret ID."""
        if not value:
            raise ValueError("Secret value must not be empty")

        master_key = self._get_master_key()
        secret_id = self._generate_id()
        derived_key = self._derive_key(master_key, secret_id)
        nonce = os.urandom(12)
        aesgcm = AESGCM(derived_key)
        ciphertext = aesgcm.encrypt(nonce, value.encode("utf-8"), None)

        now = time.time()
        expires_at = now + (expires_in_days * 86400) if expires_in_days else None

        encrypted = EncryptedSecret(
            id=secret_id,
            name=name,
            secret_class=secret_class,
            ciphertext=ciphertext,
            nonce=nonce,
            created_at=now,
            rotated_at=now,
            expires_at=expires_at,
            metadata=metadata or {},
        )

        file_path = self._secret_file_path(secret_id)
        tmp_path = file_path.with_suffix(".tmp")
        with open(tmp_path, "w") as f:
            json.dump(encrypted.to_dict(), f)
        os.rename(tmp_path, file_path)

        self._log_access(secret_id, secret_class, actor, trace_id)
        return secret_id

    def retrieve(self, secret_id: str, actor: str, trace_id: Optional[str] = None) -> str:
        """Decrypt and return a secret value. Never persisted unencrypted."""
        master_key = self._get_master_key()
        derived_key = self._derive_key(master_key, secret_id)

        file_path = self._secret_file_path(secret_id)
        if not file_path.exists():
            raise FileNotFoundError(f"Secret {secret_id} not found")

        with open(file_path) as f:
            data = json.load(f)

        encrypted = EncryptedSecret.from_dict(data)

        if encrypted.expires_at and time.time() > encrypted.expires_at:
            raise ValueError(f"Secret {secret_id} has expired")

        aesgcm = AESGCM(derived_key)
        try:
            plaintext = aesgcm.decrypt(encrypted.nonce, encrypted.ciphertext, None)
        except Exception:
            raise ValueError(f"Failed to decrypt secret {secret_id}: key mismatch or corruption")

        self._log_access(secret_id, encrypted.secret_class, actor, trace_id)
        return plaintext.decode("utf-8")

    def inject_to_tmpfs(self, secret_id: str, actor: str, trace_id: Optional[str] = None) -> Path:
        """Decrypt secret and write it to the tmpfs mount. Returns the file path."""
        value = self.retrieve(secret_id, actor, trace_id)

        file_path = self._secret_file_path(secret_id)
        with open(file_path) as f:
            data = json.load(f)

        tmpfs_file = self.tmpfs_mount / secret_id
        with open(tmpfs_file, "w") as f:
            f.write(value)
        os.chmod(tmpfs_file, 0o600)

        return tmpfs_file

    def rotate(self, secret_id: str, new_value: str, actor: str, trace_id: Optional[str] = None) -> str:
        """Rotate a secret to a new value. Returns the same secret ID."""
        master_key = self._get_master_key()
        derived_key = self._derive_key(master_key, secret_id)

        file_path = self._secret_file_path(secret_id)
        with open(file_path) as f:
            data = json.load(f)

        encrypted = EncryptedSecret.from_dict(data)
        nonce = os.urandom(12)
        aesgcm = AESGCM(derived_key)
        ciphertext = aesgcm.encrypt(nonce, new_value.encode("utf-8"), None)

        encrypted.ciphertext = ciphertext
        encrypted.nonce = nonce
        encrypted.rotated_at = time.time()
        encrypted.version += 1

        tmp_path = file_path.with_suffix(".tmp")
        with open(tmp_path, "w") as f:
            json.dump(encrypted.to_dict(), f)
        os.rename(tmp_path, file_path)

        self._log_access(secret_id, encrypted.secret_class, actor, trace_id)
        return secret_id

    def delete(self, secret_id: str, actor: str, trace_id: Optional[str] = None) -> bool:
        """Delete a secret. Returns True if it existed."""
        file_path = self._secret_file_path(secret_id)
        tmpfs_file = self.tmpfs_mount / secret_id

        if file_path.exists():
            os.unlink(file_path)
        if tmpfs_file.exists():
            os.unlink(tmpfs_file)

        return True

    def list_secrets(self) -> list[dict]:
        """List all stored secrets (metadata only, never values)."""
        secrets = []
        for file_path in self.storage_path.glob("*.enc"):
            with open(file_path) as f:
                data = json.load(f)
            secrets.append({
                "id": data["id"],
                "name": data["name"],
                "secret_class": data["secret_class"],
                "created_at": data["created_at"],
                "rotated_at": data.get("rotated_at", data["created_at"]),
                "expires_at": data.get("expires_at"),
                "version": data.get("version", 1),
            })
        return secrets

    def needs_rotation(self, secret_id: str) -> bool:
        """Check if a secret is due for rotation."""
        file_path = self._secret_file_path(secret_id)
        if not file_path.exists():
            return False
        with open(file_path) as f:
            data = json.load(f)
        rotated_at = data.get("rotated_at", data["created_at"])
        age_days = (time.time() - rotated_at) / 86400
        return age_days >= self.rotation_days

    def get_access_log(self) -> list[SecretAccess]:
        return list(self._access_log)

    def clear_access_log(self) -> None:
        self._access_log.clear()

    def redact_secrets_from_dict(self, data: dict) -> dict:
        """Remove sensitive values from a dictionary before logging."""
        return {k: self._redact_value(k, v) for k, v in data.items()}
