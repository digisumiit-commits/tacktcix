import { describe, it, expect } from 'vitest';
import { calculateBackoff } from '../src/core/retry';

describe('Retry — Exponential Backoff', () => {
  it('returns base delay for retry count 0', () => {
    const delay = calculateBackoff(0, { baseDelayMs: 1000, jitter: false });
    expect(delay).toBe(1000);
  });

  it('doubles delay for retry count 1', () => {
    const delay = calculateBackoff(1, { baseDelayMs: 1000, jitter: false });
    expect(delay).toBe(2000);
  });

  it('quadruples delay for retry count 2', () => {
    const delay = calculateBackoff(2, { baseDelayMs: 1000, jitter: false });
    expect(delay).toBe(4000);
  });

  it('caps at maxDelayMs', () => {
    const delay = calculateBackoff(10, { baseDelayMs: 1000, maxDelayMs: 5000, jitter: false });
    expect(delay).toBeLessThanOrEqual(5000);
  });

  it('applies jitter when enabled', () => {
    // Run multiple times — should vary
    const delays = new Set<number>();
    for (let i = 0; i < 50; i++) {
      delays.add(calculateBackoff(0, { baseDelayMs: 1000, jitter: true }));
    }
    // With jitter, we should see multiple values
    expect(delays.size).toBeGreaterThan(1);
  });

  it('uses default config when no overrides provided', () => {
    const delay = calculateBackoff(0);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(1000); // baseDelayMs default 1000 with jitter
  });
});
