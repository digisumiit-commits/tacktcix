import { describe, it, expect } from 'vitest';
import { priorityScore, PRIORITY_WEIGHTS, SLA_BOOST_MAX, BLOCKED_PENALTY, SLA_WINDOW_MS, Task } from '../src/types';
import { calculateSlaBoost, computeEffectiveScore } from '../src/core/priority-queue';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-task',
    title: 'Test',
    description: '',
    status: 'queued',
    priority: 'medium',
    assigneeId: null,
    parentId: null,
    retryCount: 0,
    maxRetries: 3,
    lastError: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    scheduledAt: null,
    startedAt: null,
    completedAt: null,
    slaDeadline: null,
    ...overrides,
  };
}

describe('Priority Queue', () => {
  describe('priorityScore', () => {
    it('ranks critical above high', () => {
      const now = new Date();
      const critical = priorityScore('critical', now);
      const high = priorityScore('high', now);
      expect(critical).toBeGreaterThan(high);
    });

    it('ranks older tasks higher within same priority', () => {
      const older = new Date('2024-01-01');
      const newer = new Date('2024-06-01');
      const oldScore = priorityScore('medium', older);
      const newScore = priorityScore('medium', newer);
      expect(oldScore).toBeGreaterThan(newScore);
    });

    it('cross-priority ranks critical-older above high-newer', () => {
      const older = new Date('2024-01-01');
      const newer = new Date('2026-01-01');
      // Critical from 2024 should vastly outrank high from 2026
      const criticalOld = priorityScore('critical', older);
      const highNew = priorityScore('high', newer);
      expect(criticalOld).toBeGreaterThan(highNew);
    });

    it('ranks all priority levels correctly', () => {
      const now = new Date();
      const critical = priorityScore('critical', now);
      const high = priorityScore('high', now);
      const medium = priorityScore('medium', now);
      const low = priorityScore('low', now);
      expect(critical).toBeGreaterThan(high);
      expect(high).toBeGreaterThan(medium);
      expect(medium).toBeGreaterThan(low);
    });
  });

  describe('calculateSlaBoost', () => {
    it('returns 0 when task has no SLA deadline', () => {
      const task = makeTask({ slaDeadline: null });
      expect(calculateSlaBoost(task)).toBe(0);
    });

    it('returns 0 when deadline is far in the future', () => {
      const future = new Date(Date.now() + SLA_WINDOW_MS * 2);
      const task = makeTask({ slaDeadline: future });
      expect(calculateSlaBoost(task)).toBe(0);
    });

    it('returns positive boost when deadline is approaching', () => {
      const approaching = new Date(Date.now() + SLA_WINDOW_MS / 2);
      const task = makeTask({ slaDeadline: approaching });
      const boost = calculateSlaBoost(task);
      expect(boost).toBeGreaterThan(0);
      expect(boost).toBeLessThanOrEqual(SLA_BOOST_MAX);
    });

    it('returns SLA_BOOST_MAX when deadline is past', () => {
      const past = new Date(Date.now() - 60_000);
      const task = makeTask({ slaDeadline: past });
      expect(calculateSlaBoost(task)).toBe(SLA_BOOST_MAX);
    });

    it('returns SLA_BOOST_MAX when deadline is now', () => {
      const now = new Date();
      const task = makeTask({ slaDeadline: now });
      expect(calculateSlaBoost(task)).toBe(SLA_BOOST_MAX);
    });

    it('urgency proportional to deadline proximity', () => {
      const near = new Date(Date.now() + SLA_WINDOW_MS * 0.25);
      const far = new Date(Date.now() + SLA_WINDOW_MS * 0.75);
      const nearBoost = calculateSlaBoost(makeTask({ slaDeadline: near }));
      const farBoost = calculateSlaBoost(makeTask({ slaDeadline: far }));
      expect(nearBoost).toBeGreaterThan(farBoost);
    });
  });

  describe('computeEffectiveScore', () => {
    it('returns base score when no dynamic factors apply', async () => {
      const task = makeTask();
      const base = priorityScore(task.priority, task.createdAt);
      const effective = await computeEffectiveScore(task, 0);
      expect(effective).toBe(base);
    });

    it('applies blocked penalty when task is blocked', async () => {
      const task = makeTask({ status: 'blocked' });
      const base = priorityScore(task.priority, task.createdAt);
      const effective = await computeEffectiveScore(task, 0);
      expect(effective).toBe(base - BLOCKED_PENALTY);
    });

    it('applies SLA boost when deadline is urgent', async () => {
      const now = new Date();
      const urgent = new Date(now.getTime() + 60_000); // 1 minute away
      const task = makeTask({ slaDeadline: urgent });
      const base = priorityScore(task.priority, task.createdAt);
      const effective = await computeEffectiveScore(task, 0);
      // Should be base + boost (deadline 1min away = near max)
      expect(effective).toBeGreaterThan(base);
      expect(effective).toBeLessThan(base + SLA_BOOST_MAX + 1);
    });

    it('applies manual override bump', async () => {
      const task = makeTask();
      const base = priorityScore(task.priority, task.createdAt);
      const effective = await computeEffectiveScore(task, 150_000_000_000_000);
      expect(effective).toBe(base + 150_000_000_000_000);
    });

    it('applies negative manual override bump', async () => {
      const task = makeTask();
      const base = priorityScore(task.priority, task.createdAt);
      const effective = await computeEffectiveScore(task, -100_000_000_000_000);
      expect(effective).toBe(base - 100_000_000_000_000);
    });

    it('combines all dynamic factors', async () => {
      const urgent = new Date(Date.now() + 30_000); // 30s away
      const task = makeTask({
        status: 'blocked',
        slaDeadline: urgent,
      });
      const base = priorityScore(task.priority, task.createdAt);
      const slaBoost = calculateSlaBoost(task);
      const effective = await computeEffectiveScore(task, 200_000_000_000_000);
      expect(effective).toBe(base + slaBoost - BLOCKED_PENALTY + 200_000_000_000_000);
    });
  });

  describe('Dynamic vs static ranking', () => {
    it('unblocked near-deadline task outranks blocked same-priority task', async () => {
      const urgent = new Date(Date.now() + 10_000);
      const a = makeTask({ id: 'a', priority: 'high', status: 'queued', slaDeadline: urgent, createdAt: new Date('2025-06-01') });
      const b = makeTask({ id: 'b', priority: 'high', status: 'blocked', slaDeadline: null, createdAt: new Date('2025-01-01') });

      const scoreA = await computeEffectiveScore(a, 0);
      const scoreB = await computeEffectiveScore(b, 0);

      // A (urgent SLA, unblocked) should outrank B (blocked)
      expect(scoreA).toBeGreaterThan(scoreB);
    });

    it('override can flip priority levels', async () => {
      const now = new Date();
      const lowWithBump = makeTask({ id: 'a', priority: 'low', createdAt: now });
      const critical = makeTask({ id: 'b', priority: 'critical', createdAt: now });

      const lowScore = await computeEffectiveScore(lowWithBump, 500_000_000_000_000);
      const criticalScore = await computeEffectiveScore(critical, 0);

      // Low with a +5-level bump should outrank critical
      expect(lowScore).toBeGreaterThan(criticalScore);
    });
  });
});
