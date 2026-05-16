import { pool } from '../db';

export interface RetryConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

const DEFAULT_CONFIG: RetryConfig = {
  baseDelayMs: 1000,
  maxDelayMs: 300_000, // 5 minutes
  jitter: true,
};

export function calculateBackoff(
  retryCount: number,
  overrides: Partial<RetryConfig> = {}
): number {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  const exponential = config.baseDelayMs * Math.pow(2, retryCount);
  const delay = Math.min(exponential, config.maxDelayMs);

  if (!config.jitter) return delay;

  // Jitter: randomize between 50% and 100% of the delay
  const jittered = delay * (0.5 + Math.random() * 0.5);
  return Math.round(jittered);
}

export async function markFailed(taskId: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE tasks SET status = 'failed', last_error = $2, updated_at = NOW() WHERE id = $1`,
    [taskId, error]
  );
}

export async function scheduleRetry(
  taskId: string
): Promise<{ retryCount: number; delayMs: number } | null> {
  const { rows } = await pool.query(
    `SELECT retry_count, max_retries FROM tasks WHERE id = $1`,
    [taskId]
  );
  if (rows.length === 0) return null;

  const { retry_count, max_retries } = rows[0];
  if (retry_count >= max_retries) return null;

  const nextRetryCount = retry_count + 1;
  const delayMs = calculateBackoff(retry_count);

  await pool.query(
    `UPDATE tasks SET retry_count = $2, status = 'queued', scheduled_at = NOW() + ($3 || ' ms')::INTERVAL, updated_at = NOW() WHERE id = $1`,
    [taskId, nextRetryCount, delayMs]
  );

  return { retryCount: nextRetryCount, delayMs };
}
