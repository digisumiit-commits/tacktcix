"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 600000;
const PBKDF2_DIGEST = "sha512";
const SALT_LENGTH = 32;

class EncryptedAuthStorage {
  constructor(config = {}) {
    this.storageDir = config.storageDir || path.join(process.cwd(), ".browser-auth");
    this.encryptionKey = null;
    this._keyDerived = false;
  }

  async init(masterKey) {
    if (!masterKey) {
      throw new Error("Master encryption key is required");
    }
    // Derive a stable encryption key from the master key
    const salt = crypto.createHash("sha256").update("browser-auth-storage-v1").digest();
    this.encryptionKey = await this._deriveKey(masterKey, salt);
    this._keyDerived = true;

    // Ensure storage directory exists
    await fs.mkdir(this.storageDir, { recursive: true });
  }

  async _deriveKey(masterKey, salt) {
    return new Promise((resolve, reject) => {
      crypto.pbkdf2(
        masterKey,
        salt,
        PBKDF2_ITERATIONS,
        KEY_LENGTH,
        PBKDF2_DIGEST,
        (err, derivedKey) => {
          if (err) reject(err);
          else resolve(derivedKey);
        }
      );
    });
  }

  _encrypt(plaintext) {
    if (!this._keyDerived) throw new Error("Storage not initialized. Call init(masterKey) first.");

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv);

    let encrypted = cipher.update(plaintext, "utf8");
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Format: iv (12) + authTag (16) + ciphertext
    return Buffer.concat([iv, authTag, encrypted]);
  }

  _decrypt(data) {
    if (!this._keyDerived) throw new Error("Storage not initialized. Call init(masterKey) first.");

    const iv = data.subarray(0, IV_LENGTH);
    const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, this.encryptionKey, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString("utf8");
  }

  async saveAuthState(sessionId, authState) {
    if (!this._keyDerived) throw new Error("Storage not initialized. Call init(masterKey) first.");

    const serialized = JSON.stringify({
      version: 1,
      sessionId,
      timestamp: Date.now(),
      cookies: authState.cookies || [],
      origins: authState.origins || [],
      localStorage: authState.localStorage || {},
    });

    const encrypted = this._encrypt(serialized);
    const filePath = this._authFilePath(sessionId);
    await fs.writeFile(filePath, encrypted);
  }

  async loadAuthState(sessionId) {
    if (!this._keyDerived) throw new Error("Storage not initialized. Call init(masterKey) first.");

    const filePath = this._authFilePath(sessionId);
    let encrypted;
    try {
      encrypted = await fs.readFile(filePath);
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }

    const decrypted = this._decrypt(encrypted);
    const stored = JSON.parse(decrypted);

    // Restore cookies and localStorage to a browser context
    return {
      cookies: stored.cookies,
      origins: stored.origins,
      localStorage: stored.localStorage,
      timestamp: stored.timestamp,
    };
  }

  async deleteAuthState(sessionId) {
    const filePath = this._authFilePath(sessionId);
    try {
      await fs.unlink(filePath);
      return true;
    } catch (err) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
  }

  async listAuthSessions() {
    const entries = await fs.readdir(this.storageDir).catch(() => []);
    return entries
      .filter((f) => f.startsWith("auth-") && f.endsWith(".enc"))
      .map((f) => f.replace(/^auth-/, "").replace(/\.enc$/, ""));
  }

  async restoreAuthToContext(sessionId, context) {
    const authState = await this.loadAuthState(sessionId);
    if (!authState || !authState.cookies.length) return false;

    await context.addCookies(authState.cookies);

    // Restore localStorage by evaluating in a page
    if (authState.localStorage && Object.keys(authState.localStorage).length > 0) {
      const pages = context.pages();
      if (pages.length > 0) {
        await pages[0].evaluate((storage) => {
          for (const [key, value] of Object.entries(storage)) {
            localStorage.setItem(key, value);
          }
        }, authState.localStorage);
      }
    }

    return true;
  }

  async captureAuthFromContext(sessionId, context) {
    const cookies = await context.cookies();
    if (!cookies.length) return null;

    // Capture localStorage from all open pages
    const localStorage = {};
    const pages = context.pages();
    for (const page of pages) {
      try {
        const origin = new URL(page.url()).origin;
        if (!localStorage[origin]) {
          const items = await page.evaluate(() => {
            const data = {};
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              data[key] = localStorage.getItem(key);
            }
            return data;
          });
          if (Object.keys(items).length > 0) {
            localStorage[origin] = items;
          }
        }
      } catch (_) {
        // Page may not be accessible
      }
    }

    const authState = { cookies, origins: [], localStorage };
    await this.saveAuthState(sessionId, authState);
    return authState;
  }

  _authFilePath(sessionId) {
    // Sanitize session ID for filesystem
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.storageDir, `auth-${safe}.enc`);
  }

  async destroy() {
    this.encryptionKey = null;
    this._keyDerived = false;
  }
}

module.exports = { EncryptedAuthStorage };
