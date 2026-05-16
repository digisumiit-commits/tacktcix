import { HeartbeatEngineConfig, runHeartbeat } from './engine';
import { HeartbeatResult } from '../types';

export interface LoopConfig extends HeartbeatEngineConfig {
  /** If true, run once and exit. If false, loop forever until stopped. */
  once: boolean;
  /** Callback after each heartbeat — for logging, metrics, persistence. */
  onResult?: (result: HeartbeatResult) => void | Promise<void>;
  /** Signal to stop the loop. Polled between heartbeats. */
  signal?: AbortSignal;
}

export async function runLoop(config: LoopConfig): Promise<HeartbeatResult[]> {
  const results: HeartbeatResult[] = [];

  while (true) {
    if (config.signal?.aborted) {
      console.log('[heartbeat] Loop stopped by signal');
      break;
    }

    const result = await runHeartbeat(config);
    results.push(result);

    if (config.onResult) {
      await config.onResult(result);
    }

    if (config.once) break;

    // Sleep until the next heartbeat
    if (config.signal) {
      // Sleep with abort support
      const aborted = await sleepAbortable(result.nextHeartbeatMs, config.signal);
      if (aborted) break;
    } else {
      await sleep(result.nextHeartbeatMs);
    }
  }

  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve(true);
    }, { once: true });
  });
}
