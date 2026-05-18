"use strict";

class SelectorTimeoutError extends Error {
  constructor(selector, timeouts, attempts) {
    super(`Selector "${selector}" not resolved after ${attempts} attempts (total timeout: ${timeouts.reduce((a, b) => a + b, 0)}ms)`);
    this.name = "SelectorTimeoutError";
    this.selector = selector;
    this.attempts = attempts;
  }
}

const DEFAULT_STRATEGIES = [
  {
    name: "css",
    type: "css",
    timeout: 10000,
  },
  {
    name: "text",
    type: "text",
    timeout: 5000,
  },
  {
    name: "xpath",
    type: "xpath",
    timeout: 5000,
  },
  {
    name: "aria",
    type: "aria",
    timeout: 5000,
  },
  {
    name: "stagehand-ai",
    type: "ai",
    timeout: 30000,
  },
];

class SelectorStrategies {
  constructor(config = {}) {
    this.strategies = config.strategies || [...DEFAULT_STRATEGIES];
    this.maxRetries = config.maxRetries || 3;
    this.retryDelayMs = config.retryDelayMs || 1000;
    this.failFast = config.failFast ?? false;
    this.aiResolve = config.aiResolve || null; // async fn(description, page) => locator
  }

  setAIResolver(fn) {
    this.aiResolve = fn;
  }

  async find(page, selector, options = {}) {
    const strategies = options.strategies || this.strategies;
    const maxRetries = options.maxRetries ?? this.maxRetries;
    const retryDelayMs = options.retryDelayMs ?? this.retryDelayMs;
    const failFast = options.failFast ?? this.failFast;
    const state = options.state || "visible";

    const errors = [];

    for (const strategy of strategies) {
      let attempt = 0;
      let lastError = null;

      while (attempt < maxRetries) {
        try {
          const result = await this._tryStrategy(
            page,
            strategy,
            selector,
            state,
            options.timeout ?? strategy.timeout
          );
          if (result) return result;
          lastError = new Error(`Strategy ${strategy.name} returned no element`);
        } catch (err) {
          lastError = err;
        }

        attempt++;
        if (attempt < maxRetries && retryDelayMs > 0) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
        }
      }

      if (lastError) {
        errors.push({ strategy: strategy.name, error: lastError.message });
      }

      if (failFast) break;
    }

    throw new SelectorTimeoutError(
      selector,
      strategies.map((s) => s.timeout),
      maxRetries * strategies.length
    );
  }

  async findAll(page, selector, options = {}) {
    const strategies = options.strategies || this.strategies;
    const state = options.state || "attached";

    for (const strategy of strategies) {
      try {
        const result = await this._tryStrategy(page, strategy, selector, state, strategy.timeout, true);
        if (result && (Array.isArray(result) ? result.length > 0 : result)) {
          return result;
        }
      } catch (_) {
        // Continue to next strategy
      }
    }

    return [];
  }

  async click(page, selector, options = {}) {
    const element = await this.find(page, selector, options);
    await element.click({
      force: options.force ?? false,
      noWaitAfter: options.noWaitAfter ?? false,
      ...options.clickOptions,
    });
    return element;
  }

  async fill(page, selector, value, options = {}) {
    const element = await this.find(page, selector, options);
    await element.fill(value, options.fillOptions || {});
    return element;
  }

  async type(page, selector, text, options = {}) {
    const element = await this.find(page, selector, options);
    await element.type(text, { delay: options.delay || 0 });
    return element;
  }

  async waitAndFind(page, selector, options = {}) {
    const strategies = options.strategies || this.strategies;
    const maxRetries = options.maxRetries ?? this.maxRetries;
    const retryDelayMs = options.retryDelayMs ?? this.retryDelayMs;
    const waitBefore = options.waitBeforeMs || 0;
    const waitBetween = options.waitBetweenMs || 500;

    if (waitBefore > 0) {
      await new Promise((r) => setTimeout(r, waitBefore));
    }

    let lastError = null;

    for (const strategy of strategies) {
      let attempt = 0;
      while (attempt < maxRetries) {
        try {
          const result = await this._tryStrategy(
            page,
            strategy,
            selector,
            options.state || "visible",
            options.timeout ?? strategy.timeout
          );
          if (result) return result;
        } catch (err) {
          lastError = err;
          await new Promise((r) => setTimeout(r, retryDelayMs));
        }
        attempt++;

        if (attempt < maxRetries && waitBetween > 0 && retryDelayMs > 0) {
          await new Promise((r) => setTimeout(r, waitBetween));
        }
      }
    }

    throw lastError || new Error(`waitAndFind: could not resolve "${selector}"`);
  }

  async _tryStrategy(page, strategy, selector, state, timeout, multiple = false) {
    const locator = this._buildLocator(page, strategy, selector);

    if (strategy.type === "ai") {
      if (!this.aiResolve) return null;
      try {
        const element = await this.aiResolve(selector, page);
        return element;
      } catch (_) {
        return null;
      }
    }

    // Standard Playwright locator-based resolution
    try {
      if (multiple) {
        await locator.first().waitFor({ state, timeout });
        return locator;
      }
      await locator.waitFor({ state, timeout });
      return locator;
    } catch (_) {
      return null;
    }
  }

  _buildLocator(page, strategy, selector) {
    switch (strategy.type) {
      case "css":
        return page.locator(selector);
      case "text":
        return page.getByText(selector, { exact: strategy.exact ?? false });
      case "xpath":
        return page.locator(`xpath=${selector}`);
      case "aria":
        return page.locator(`[aria-label="${selector}"]`);
      case "role":
        return page.getByRole(strategy.role || "button", {
          name: selector,
          ...(strategy.roleOptions || {}),
        });
      case "testid":
        return page.getByTestId(selector);
      case "placeholder":
        return page.getByPlaceholder(selector);
      case "label":
        return page.getByLabel(selector);
      default:
        return page.locator(selector);
    }
  }

  static createDefault() {
    return new SelectorStrategies();
  }

  static presets = {
    aggressive: {
      strategies: [
        { name: "css", type: "css", timeout: 3000 },
        { name: "text", type: "text", timeout: 2000 },
        { name: "xpath", type: "xpath", timeout: 2000 },
        { name: "aria", type: "aria", timeout: 2000 },
      ],
      maxRetries: 2,
      retryDelayMs: 500,
      failFast: false,
    },
    conservative: {
      strategies: [
        { name: "css", type: "css", timeout: 15000 },
        { name: "text", type: "text", timeout: 10000 },
        { name: "xpath", type: "xpath", timeout: 10000 },
        { name: "aria", type: "aria", timeout: 10000 },
        { name: "role", type: "role", timeout: 10000 },
        { name: "stagehand-ai", type: "ai", timeout: 60000 },
      ],
      maxRetries: 5,
      retryDelayMs: 2000,
      failFast: false,
    },
    formFields: {
      strategies: [
        { name: "css", type: "css", timeout: 5000 },
        { name: "placeholder", type: "placeholder", timeout: 5000 },
        { name: "label", type: "label", timeout: 5000 },
        { name: "aria", type: "aria", timeout: 5000 },
        { name: "xpath", type: "xpath", timeout: 5000 },
      ],
      maxRetries: 3,
      retryDelayMs: 1000,
      failFast: false,
    },
    strict: {
      strategies: [{ name: "css", type: "css", timeout: 30000 }],
      maxRetries: 1,
      retryDelayMs: 0,
      failFast: true,
    },
  };
}

module.exports = { SelectorStrategies, SelectorTimeoutError };
