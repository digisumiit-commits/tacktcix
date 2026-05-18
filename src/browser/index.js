"use strict";

const { SessionManager } = require("./session-manager");
const { EncryptedAuthStorage } = require("./auth-storage");
const { ScreenshotCapture } = require("./screenshot");
const { SelectorStrategies } = require("./selector-strategies");

class BrowserAutomationService {
  constructor(config = {}) {
    this.config = config;
    this.sessions = new SessionManager(config.session || {});
    this.auth = new EncryptedAuthStorage(config.auth || {});
    this.screenshots = new ScreenshotCapture(config.screenshot || {});
    this.selectors = new SelectorStrategies(config.selectors || {});
    this._initialized = false;
  }

  async init(options = {}) {
    await this.sessions.init();

    const authInitialized = options.masterKey
      ? await this.auth.init(options.masterKey).then(() => true).catch(() => false)
      : false;

    await this.screenshots.init();

    // Wire up AI resolver from Stagehand if enabled
    if (options.aiResolve) {
      this.selectors.setAIResolver(options.aiResolve);
    }

    this._initialized = true;

    return {
      initialized: true,
      authStorageReady: authInitialized,
      browserConnected: this.sessions.health.browserConnected,
    };
  }

  // --- Session operations ---

  async newSession(options = {}) {
    this._checkInit();
    const session = await this.sessions.createSession(options);

    // Auto-restore auth if session has an auth profile
    if (options.authProfile && this.auth._keyDerived) {
      const restored = await this.auth.restoreAuthToContext(
        options.authProfile,
        session.context
      );
      if (restored) {
        session._authRestored = true;
      }
    }

    return session;
  }

  async closeSession(sessionId, options = {}) {
    const session = this.sessions.getSession(sessionId);
    if (session && options.captureAuth && this.auth._keyDerived) {
      await this.auth.captureAuthFromContext(sessionId, session.context);
    }
    await this.sessions.closeSession(sessionId);
  }

  getSession(sessionId) {
    return this.sessions.getSession(sessionId);
  }

  listSessions() {
    return this.sessions.listSessions();
  }

  // --- Screenshot operations ---

  async screenshot(sessionId, options = {}) {
    const session = this.sessions.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return this.screenshots.captureAndSave(session.page, options);
  }

  // --- Selector operations ---

  async find(sessionId, selector, options = {}) {
    const session = this.sessions.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return this.selectors.find(session.page, selector, options);
  }

  async click(sessionId, selector, options = {}) {
    const session = this.sessions.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return this.selectors.click(session.page, selector, options);
  }

  async fill(sessionId, selector, value, options = {}) {
    const session = this.sessions.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return this.selectors.fill(session.page, selector, value, options);
  }

  // --- Auth operations ---

  async saveAuth(sessionId) {
    const session = this.sessions.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return this.auth.captureAuthFromContext(sessionId, session.context);
  }

  async loadAuth(sessionId) {
    const session = this.sessions.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return this.auth.restoreAuthToContext(sessionId, session.context);
  }

  // --- Navigate ---

  async navigate(sessionId, url, options = {}) {
    const session = this.sessions.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const waitUntil = options.waitUntil || "domcontentloaded";
    const response = await session.page.goto(url, {
      waitUntil,
      timeout: options.timeout || 30000,
      ...options.gotoOptions,
    });

    return {
      url: session.page.url(),
      status: response?.status() || null,
      ok: response?.ok() ?? false,
    };
  }

  // --- Evaluate ---

  async evaluate(sessionId, fnOrExpression, arg) {
    const session = this.sessions.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    if (typeof fnOrExpression === "function") {
      return session.page.evaluate(fnOrExpression, arg);
    }
    return session.page.evaluate(fnOrExpression);
  }

  // --- Stagehand AI operations ---

  async act(sessionId, instruction) {
    const stagehand = this.sessions.getStagehand(sessionId);
    if (!stagehand) throw new Error(`Stagehand not enabled for session ${sessionId}`);
    return stagehand.act({ action: instruction });
  }

  async extract(sessionId, instruction, schema) {
    const stagehand = this.sessions.getStagehand(sessionId);
    if (!stagehand) throw new Error(`Stagehand not enabled for session ${sessionId}`);
    return stagehand.extract({ instruction, schema });
  }

  // --- Health ---

  get health() {
    return {
      ...this.sessions.health,
      authStorageEnabled: this.auth._keyDerived,
      initialized: this._initialized,
    };
  }

  // --- Cleanup ---

  async destroy() {
    await this.sessions.destroy();
    await this.auth.destroy();
  }

  _checkInit() {
    if (!this._initialized) {
      throw new Error("BrowserAutomationService not initialized. Call init() first.");
    }
  }
}

module.exports = { BrowserAutomationService };
