"use strict";

const { chromium } = require("playwright");
const { Stagehand } = require("@browserbasehq/stagehand");
const crypto = require("crypto");

const DEFAULT_CONFIG = {
  // Browserless / remote browser endpoint
  browserWSEndpoint: null,
  // Launch locally if no remote endpoint
  headless: true,
  // Session isolation: each session is a discrete browser context
  isolation: "context",
  // Max concurrent sessions
  maxSessions: 4,
  // Session idle timeout (ms)
  sessionIdleTimeoutMs: 300000,
  // Enable Stagehand AI-driven automation (requires BROWSERBASE_API_KEY)
  stagehand: false,
  // Browser launch args
  launchArgs: [
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=TranslateUI",
    "--disable-ipc-flooding-protection",
  ],
};

class SessionManager {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._browser = null;
    this._sessions = new Map();
    this._stagehandInstances = new Map();
    this._cleanupTimers = new Map();
  }

  async init() {
    if (this._browser && this._browser.isConnected()) return;

    if (this.config.browserWSEndpoint) {
      this._browser = await chromium.connectOverCDP(this.config.browserWSEndpoint);
    } else {
      this._browser = await chromium.launch({
        headless: this.config.headless,
        args: this.config.launchArgs,
      });
    }

    this._browser.on("disconnected", () => {
      this._browser = null;
      this._sessions.clear();
    });
  }

  async createSession(options = {}) {
    await this.init();

    const sessionId = options.id || crypto.randomUUID();
    if (this._sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    if (this._sessions.size >= this.config.maxSessions) {
      throw new Error(
        `Max sessions (${this.config.maxSessions}) reached. Close a session first.`
      );
    }

    const contextOptions = {
      userAgent: options.userAgent || null,
      viewport: options.viewport || { width: 1280, height: 720 },
      locale: options.locale || "en-US",
      timezoneId: options.timezoneId || "America/Los_Angeles",
      permissions: options.permissions || [],
      geolocation: options.geolocation || undefined,
      colorScheme: options.colorScheme || "light",
      ...options.contextOverrides,
    };

    const context = await this._browser.newContext(contextOptions);
    const page = await context.newPage();

    // Apply network interception for request/response logging if enabled
    if (options.logNetwork) {
      await this._setupNetworkLogging(page);
    }

    const session = {
      id: sessionId,
      context,
      page,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      metadata: options.metadata || {},
    };

    this._sessions.set(sessionId, session);
    this._resetIdleTimer(sessionId);

    // Optionally initialize Stagehand for this session
    if (this.config.stagehand || options.stagehand) {
      await this._initStagehandForSession(sessionId, options.stagehandOptions);
    }

    return session;
  }

  async _setupNetworkLogging(page) {
    page.on("request", (req) => {
      if (req.url().startsWith("data:")) return;
      page._networkLog = page._networkLog || [];
      page._networkLog.push({
        type: "request",
        url: req.url(),
        method: req.method(),
        headers: req.headers(),
        timestamp: Date.now(),
      });
    });
    page.on("response", (resp) => {
      page._networkLog = page._networkLog || [];
      page._networkLog.push({
        type: "response",
        url: resp.url(),
        status: resp.status(),
        headers: resp.headers(),
        timestamp: Date.now(),
      });
    });
  }

  async _initStagehandForSession(sessionId, stagehandOptions = {}) {
    const session = this._sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const stagehand = new Stagehand({
      env: "LOCAL",
      headless: this.config.headless,
      verbose: stagehandOptions?.verbose ?? 0,
      ...stagehandOptions,
    });

    // Attach Stagehand to the existing page / context
    await stagehand.init();
    // Replace the Stagehand-managed page with our isolated page
    await stagehand.page.close();
    Object.defineProperty(stagehand, "page", {
      value: session.page,
      writable: false,
    });
    Object.defineProperty(stagehand, "context", {
      value: session.context,
      writable: false,
    });

    this._stagehandInstances.set(sessionId, stagehand);
  }

  getSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return null;
    session.lastUsedAt = Date.now();
    this._resetIdleTimer(sessionId);
    return session;
  }

  getStagehand(sessionId) {
    return this._stagehandInstances.get(sessionId) || null;
  }

  listSessions() {
    return Array.from(this._sessions.values()).map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      metadata: s.metadata,
      hasStagehand: this._stagehandInstances.has(s.id),
    }));
  }

  async closeSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return;

    // Clear idle timer
    const timer = this._cleanupTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this._cleanupTimers.delete(sessionId);
    }

    // Close Stagehand if active
    const stagehand = this._stagehandInstances.get(sessionId);
    if (stagehand) {
      try {
        await stagehand.close();
      } catch (_) {
        // Stagehand may have already been closed
      }
      this._stagehandInstances.delete(sessionId);
    }

    // Close the browser context (and all its pages)
    await session.context.close();
    this._sessions.delete(sessionId);
  }

  async closeAll() {
    const ids = Array.from(this._sessions.keys());
    await Promise.all(ids.map((id) => this.closeSession(id)));
  }

  async destroy() {
    await this.closeAll();
    if (this._browser && this._browser.isConnected()) {
      await this._browser.close();
    }
    this._browser = null;
  }

  _resetIdleTimer(sessionId) {
    const existing = this._cleanupTimers.get(sessionId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.closeSession(sessionId).catch(() => {});
    }, this.config.sessionIdleTimeoutMs);
    timer.unref();
    this._cleanupTimers.set(sessionId, timer);
  }

  get health() {
    return {
      browserConnected: this._browser?.isConnected() ?? false,
      activeSessions: this._sessions.size,
      maxSessions: this.config.maxSessions,
      stagehandEnabled: this.config.stagehand,
    };
  }
}

module.exports = { SessionManager, DEFAULT_CONFIG };
