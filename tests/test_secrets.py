"""Tests for encrypted secrets store."""

import base64
import json
import os
import tempfile
import time

from src.secrets import EncryptedSecretsStore, SecretClass


def make_key() -> str:
    return base64.b64encode(os.urandom(32)).decode()


class TestEncryptedSecretsStore:
    def setup_method(self):
        self.tmp = tempfile.mkdtemp()
        self.tmpfs = tempfile.mkdtemp()
        self.key_file = os.path.join(self.tmp, "master.key")
        self.key = make_key()
        with open(self.key_file, "w") as f:
            f.write(self.key)

        self.store = EncryptedSecretsStore(
            storage_path=os.path.join(self.tmp, "secrets"),
            tmpfs_mount=self.tmpfs,
            key_source="local",
            key_file=self.key_file,
        )

    def teardown_method(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)
        shutil.rmtree(self.tmpfs, ignore_errors=True)

    def test_store_and_retrieve_secret(self):
        sid = self.store.store("test-key", "super-secret-value", SecretClass.API_KEY, "test-agent")
        assert sid
        assert len(sid) == 32  # hex of 16 bytes

        value = self.store.retrieve(sid, "test-agent")
        assert value == "super-secret-value"

    def test_retrieve_nonexistent_secret(self):
        try:
            self.store.retrieve("nonexistent", "test-agent")
            assert False, "Should have raised"
        except FileNotFoundError:
            pass

    def test_secret_not_stored_in_plaintext(self):
        sid = self.store.store("test-key", "super-secret-value", SecretClass.API_KEY, "test-agent")

        # Check that the stored file does not contain the plaintext
        secret_file = os.path.join(self.tmp, "secrets", f"{sid}.enc")
        with open(secret_file) as f:
            data = json.load(f)

        assert "super-secret-value" not in json.dumps(data)
        assert "ciphertext" in data
        assert "nonce" in data

    def test_rotate_secret(self):
        sid = self.store.store("test-key", "original-value", SecretClass.API_KEY, "test-agent")

        self.store.rotate(sid, "new-value", "test-agent")

        value = self.store.retrieve(sid, "test-agent")
        assert value == "new-value"

    def test_delete_secret(self):
        sid = self.store.store("test-key", "value", SecretClass.API_KEY, "test-agent")
        assert self.store.delete(sid, "test-agent")

        try:
            self.store.retrieve(sid, "test-agent")
            assert False, "Should have raised after delete"
        except FileNotFoundError:
            pass

    def test_list_secrets_never_exposes_values(self):
        self.store.store("key1", "value1", SecretClass.API_KEY, "test-agent")
        self.store.store("key2", "value2", SecretClass.DATABASE_CRED, "test-agent")

        secrets = self.store.list_secrets()
        assert len(secrets) == 2
        for s in secrets:
            assert "ciphertext" not in s
            assert "nonce" not in s
            assert s["name"] in ("key1", "key2")

    def test_inject_to_tmpfs(self):
        sid = self.store.store("test-key", "tmpfs-value", SecretClass.API_KEY, "test-agent")

        path = self.store.inject_to_tmpfs(sid, "test-agent")
        assert path.exists()
        assert str(path).startswith(self.tmpfs)

        with open(path) as f:
            assert f.read() == "tmpfs-value"

    def test_access_log_tracks_accesses(self):
        sid = self.store.store("test-key", "value", SecretClass.API_KEY, "test-agent")
        self.store.retrieve(sid, "test-agent")

        log = self.store.get_access_log()
        assert len(log) == 2
        assert log[0].secret_class == SecretClass.API_KEY
        assert log[0].accessed_by == "test-agent"

    def test_needs_rotation(self):
        sid = self.store.store("test-key", "value", SecretClass.API_KEY, "test-agent")

        # Override rotation time in stored file to be old
        secret_file = os.path.join(self.tmp, "secrets", f"{sid}.enc")
        with open(secret_file) as f:
            data = json.load(f)
        data["rotated_at"] = time.time() - (31 * 86400)  # 31 days ago
        with open(secret_file, "w") as f:
            json.dump(data, f)

        assert self.store.needs_rotation(sid) is True

    def test_redaction_strips_sensitive_keys(self):
        data = {
            "name": "test",
            "api_key": "sk-1234567890abcdefghij",
            "settings": {"debug": True},
        }
        redacted = self.store.redact_secrets_from_dict(data)
        assert redacted["api_key"] == "[REDACTED]"
        assert redacted["name"] == "test"

    def test_reject_empty_secret(self):
        try:
            self.store.store("empty", "", SecretClass.API_KEY, "test-agent")
            assert False, "Should have raised"
        except ValueError:
            pass
