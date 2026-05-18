"use strict";

const { BrowserAutomationService } = require("./browser");
const { SessionManager } = require("./browser/session-manager");
const { EncryptedAuthStorage } = require("./browser/auth-storage");
const { ScreenshotCapture } = require("./browser/screenshot");
const { SelectorStrategies, SelectorTimeoutError } = require("./browser/selector-strategies");

module.exports = {
  BrowserAutomationService,
  SessionManager,
  EncryptedAuthStorage,
  ScreenshotCapture,
  SelectorStrategies,
  SelectorTimeoutError,
};
