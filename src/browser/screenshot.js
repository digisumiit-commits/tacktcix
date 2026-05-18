"use strict";

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

class ScreenshotCapture {
  constructor(config = {}) {
    this.outputDir = config.outputDir || path.join(process.cwd(), ".screenshots");
    this.defaultFormat = config.defaultFormat || "png";
    this.defaultQuality = config.defaultQuality || 80; // jpeg only
    this.fullPage = config.fullPage ?? true;
    this.includeTimestamps = config.includeTimestamps ?? true;
    this.maxScreenshots = config.maxScreenshots || 1000;
  }

  async init() {
    await fs.mkdir(this.outputDir, { recursive: true });
  }

  async capture(page, options = {}) {
    const format = options.format || this.defaultFormat;
    const fullPage = options.fullPage ?? this.fullPage;
    const quality = format === "jpeg" ? (options.quality || this.defaultQuality) : undefined;

    const screenshotOptions = {
      type: format,
      fullPage,
      ...(quality !== undefined && { quality }),
      ...options.playwrightOptions,
    };

    // If capturing a specific element
    if (options.selector) {
      const element = await page.$(options.selector);
      if (!element) {
        throw new Error(`Element not found for screenshot: ${options.selector}`);
      }
      return element.screenshot(screenshotOptions);
    }

    // If capturing a clip region
    if (options.clip) {
      screenshotOptions.clip = options.clip;
      screenshotOptions.fullPage = false;
    }

    const buffer = await page.screenshot(screenshotOptions);
    return buffer;
  }

  async captureAndSave(page, options = {}) {
    const buffer = await this.capture(page, options);

    const filename = this._generateFilename(options);
    const filePath = path.join(this.outputDir, filename);
    await fs.writeFile(filePath, buffer);

    // Enforce max screenshot limit
    await this._enforceLimit();

    return {
      filePath,
      filename,
      size: buffer.length,
      format: options.format || this.defaultFormat,
    };
  }

  async captureMultiple(page, selectors, options = {}) {
    const results = [];
    for (const sel of selectors) {
      try {
        const result = await this.captureAndSave(page, {
          ...options,
          selector: sel,
          label: typeof sel === "string" ? sel : sel.label || sel.selector,
        });
        results.push({ selector: sel, ...result, success: true });
      } catch (err) {
        results.push({ selector: sel, success: false, error: err.message });
      }
    }
    return results;
  }

  async captureSequence(pages, options = {}) {
    const results = [];
    for (let i = 0; i < pages.length; i++) {
      const label = options.labels?.[i] || `step-${i + 1}`;
      const result = await this.captureAndSave(pages[i], { ...options, label });
      results.push(result);
    }
    return results;
  }

  async list(options = {}) {
    const sort = options.sort || "newest";
    const limit = options.limit || 50;

    let files = await fs.readdir(this.outputDir);
    files = files.filter((f) => /^screenshot-.*\.(png|jpeg|webp)$/.test(f));

    const stats = await Promise.all(
      files.map(async (f) => {
        const s = await fs.stat(path.join(this.outputDir, f));
        return { filename: f, size: s.size, mtime: s.mtimeMs };
      })
    );

    stats.sort((a, b) =>
      sort === "newest" ? b.mtime - a.mtime : a.mtime - b.mtime
    );

    return stats.slice(0, limit);
  }

  async cleanup(olderThanMs) {
    const files = await fs.readdir(this.outputDir);
    const now = Date.now();
    let removed = 0;

    for (const f of files) {
      if (!/^screenshot-.*\.(png|jpeg|webp)$/.test(f)) continue;
      const filePath = path.join(this.outputDir, f);
      const stat = await fs.stat(filePath);
      if (now - stat.mtimeMs > olderThanMs) {
        await fs.unlink(filePath);
        removed++;
      }
    }
    return removed;
  }

  async prune(maxAgeMs = 86400000) {
    return this.cleanup(maxAgeMs);
  }

  _generateFilename(options = {}) {
    const ts = this.includeTimestamps
      ? new Date().toISOString().replace(/[:.]/g, "-")
      : crypto.randomUUID().slice(0, 8);
    const label = options.label ? `-${options.label.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32)}` : "";
    return `screenshot-${ts}${label}.${options.format || this.defaultFormat}`;
  }

  async _enforceLimit() {
    const files = await fs.readdir(this.outputDir);
    const screenshots = files.filter((f) => /^screenshot-.*\.(png|jpeg|webp)$/.test(f));

    if (screenshots.length > this.maxScreenshots) {
      const stats = await Promise.all(
        screenshots.map(async (f) => {
          const s = await fs.stat(path.join(this.outputDir, f));
          return { name: f, mtime: s.mtimeMs };
        })
      );
      stats.sort((a, b) => a.mtime - b.mtime);

      const toDelete = stats.slice(0, screenshots.length - this.maxScreenshots);
      await Promise.all(
        toDelete.map((f) => fs.unlink(path.join(this.outputDir, f.name)))
      );
    }
  }
}

module.exports = { ScreenshotCapture };
