import { describe, it, expect, vi } from 'vitest';
import { scanTasks } from '../src/scanner/scanner';
import { PaperclipClient } from '../src/api/client';
import { PaperclipIssue } from '../src/types';

function makeIssue(overrides: Partial<PaperclipIssue> = {}): PaperclipIssue {
  const now = new Date().toISOString();
  return {
    id: '00000000-0000-0000-0000-000000000001',
    title: 'Test issue',
    description: '',
    status: 'todo',
    priority: 'medium',
    assigneeAgentId: 'agent-1',
    parentId: null,
    goalId: null,
    blockedByIssueIds: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('Heartbeat Scanner', () => {
  it('returns empty result when no issues assigned', async () => {
    const client = { getAssignedIssues: vi.fn().mockResolvedValue([]) } as unknown as PaperclipClient;
    const result = await scanTasks({ client });
    expect(result.tasks).toEqual([]);
    expect(result.staleTasks).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it('detects stale in_progress tasks', async () => {
    const staleIssue = makeIssue({
      id: 'stale-1',
      status: 'in_progress',
      updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 hour ago
    });
    const freshIssue = makeIssue({
      id: 'fresh-1',
      status: 'in_progress',
      updatedAt: new Date().toISOString(),
    });
    const client = {
      getAssignedIssues: vi.fn().mockResolvedValue([staleIssue, freshIssue]),
    } as unknown as PaperclipClient;

    const result = await scanTasks({ client });
    expect(result.staleTasks).toHaveLength(1);
    expect(result.staleTasks[0].id).toBe('stale-1');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].reason).toBe('stale_in_progress');
  });

  it('detects stuck in_review tasks', async () => {
    const stuckIssue = makeIssue({
      id: 'stuck-1',
      status: 'in_review',
      updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    const client = {
      getAssignedIssues: vi.fn().mockResolvedValue([stuckIssue]),
    } as unknown as PaperclipClient;

    const result = await scanTasks({ client });
    expect(result.failures[0].reason).toBe('stuck_in_review');
  });

  it('detects unassigned critical tasks', async () => {
    const criticalIssue = makeIssue({
      id: 'crit-1',
      priority: 'critical',
      assigneeAgentId: null,
    });
    const client = {
      getAssignedIssues: vi.fn().mockResolvedValue([criticalIssue]),
    } as unknown as PaperclipClient;

    const result = await scanTasks({ client });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].reason).toBe('unassigned_critical');
    expect(result.failures[0].severity).toBe('critical');
  });

  it('does not flag non-stale todo tasks', async () => {
    const todoIssue = makeIssue({ status: 'todo' });
    const client = {
      getAssignedIssues: vi.fn().mockResolvedValue([todoIssue]),
    } as unknown as PaperclipClient;

    const result = await scanTasks({ client });
    expect(result.staleTasks).toEqual([]);
  });
});
