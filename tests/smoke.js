"use strict";

const {
  BrowserAutomationService,
  SessionManager,
  EncryptedAuthStorage,
  ScreenshotCapture,
  SelectorStrategies,
  SelectorTimeoutError,
} = require("../src");

const MASTER_KEY = "smoke-test-key-32-bytes-long!!";

async function main() {
  let failures = 0;
  console.log("=== Browser Automation Smoke Test ===\n");

  // Test 1: Module loading
  console.log("[1/6] Module exports...");
  const mods = [
    BrowserAutomationService,
    SessionManager,
    EncryptedAuthStorage,
    ScreenshotCapture,
    SelectorStrategies,
    SelectorTimeoutError,
  ];
  mods.forEach((m, i) => {
    if (!m) {
      console.log(`  FAIL: export ${i} is null/undefined`);
      failures++;
    }
  });
  console.log("  PASS: all 6 modules exported");

  // Test 2: EncryptedAuthStorage
  console.log("[2/6] EncryptedAuthStorage...");
  const auth = new EncryptedAuthStorage();
  await auth.init(MASTER_KEY);

  const testCookies = [
    { name: "session", value: "abc123", domain: "example.com", path: "/" },
    { name: "token", value: "xyz789", domain: "example.com", path: "/" },
  ];
  await auth.saveAuthState("test-session", {
    cookies: testCookies,
    origins: [],
    localStorage: { "https://example.com": { theme: "dark" } },
  });

  const loaded = await auth.loadAuthState("test-session");
  if (!loaded || loaded.cookies.length !== 2) {
    console.log("  FAIL: auth save/load roundtrip");
    failures++;
  } else {
    console.log("  PASS: auth save/load roundtrip");
  }

  // Test 3: ScreenshotCapture
  console.log("[3/6] ScreenshotCapture...");
  const ss = new ScreenshotCapture({ outputDir: "/tmp/smoke-screenshots" });
  await ss.init();
  const filename = ss._generateFilename({ format: "png", label: "smoke" });
  if (!filename.startsWith("screenshot-") || !filename.endsWith(".png")) {
    console.log(`  FAIL: filename generation: ${filename}`);
    failures++;
  } else {
    console.log("  PASS: screenshot filename generation");
  }

  // Test 4: SelectorStrategies
  console.log("[4/6] SelectorStrategies...");
  const sel = new SelectorStrategies();
  if (!sel.strategies || sel.strategies.length < 2) {
    console.log("  FAIL: strategy list");
    failures++;
  } else {
    console.log(`  PASS: ${sel.strategies.length} strategies configured`);
  }

  // Verify presets
  for (const name of Object.keys(SelectorStrategies.presets)) {
    const preset = SelectorStrategies.presets[name];
    if (!preset.strategies || !preset.maxRetries) {
      console.log(`  FAIL: preset "${name}"`);
      failures++;
    }
  }
  console.log(`  PASS: ${Object.keys(SelectorStrategies.presets).length} presets (aggressive, conservative, formFields, strict)`);

  // Test 5: SessionManager (without launching browser)
  console.log("[5/6] SessionManager configuration...");
  const sm = new SessionManager();
  if (sm.config.maxSessions !== 4 || sm.config.headless !== true) {
    console.log("  FAIL: default config");
    failures++;
  } else {
    console.log("  PASS: default session config");
  }

  if (sm.health.browserConnected !== false || sm.health.activeSessions !== 0) {
    console.log("  FAIL: health before init");
    failures++;
  } else {
    console.log("  PASS: health check before init");
  }

  // Test 6: BrowserAutomationService composition
  console.log("[6/6] BrowserAutomationService composition...");
  const service = new BrowserAutomationService({
    auth: { storageDir: "/tmp/smoke-auth" },
    screenshot: { outputDir: "/tmp/smoke-screenshots" },
  });

  const initResult = await service.init({ masterKey: MASTER_KEY });
  if (!initResult.initialized || !initResult.authStorageReady) {
    console.log("  FAIL: service initialization");
    failures++;
  } else {
    console.log("  PASS: service initialized");
  }

  await service.destroy();

  // Cleanup
  await auth.deleteAuthState("test-session");
  await auth.destroy();

  console.log(`\n=== ${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`} ===`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
