import { describe, it, expect } from 'vitest';
import { prioritizeTasks, pickTopTask } from '../src/prioritizer/prioritizer';
import { PaperclipIssue } from '../src/types';

function makeIssue(overrides: Partial<PaperclipIssue> = {}): PaperclipIssue {
  const now = new Date().toISOString();
  return {
    id: '00000000-0000-0000-0000-000000000001',
    title: 'Test',
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

describe('Heartbeat Prioritizer', () => {
  it('ranks critical above medium', () => {
    const issues: PaperclipIssue[] = [
      makeIssue({ id: 'a', priority: 'medium' }),
      makeIssue({ id: 'b', priority: 'critical' }),
    ];
    const result = prioritizeTasks(issues, 'cto');
    expect(result[0].id).toBe('b');
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });

  it('boosts in_progress for momentum', () => {
    const issues: PaperclipIssue[] = [
      makeIssue({ id: 'a', status: 'todo', priority: 'critical' }),
      makeIssue({ id: 'b', status: 'in_progress', priority: 'high' }),
    ];
    const result = prioritizeTasks(issues, 'developer');
    // in_progress gets +30 bonus, which may beat critical in some cases
    expect(result[0].status).toBe('in_progress');
  });

  it('CTO boosts blocked tasks above same-priority todo', () => {
    const issues: PaperclipIssue[] = [
      makeIssue({ id: 'a', status: 'todo', priority: 'low' }),
      makeIssue({ id: 'b', status: 'blocked', priority: 'critical' }),
    ];
    const ctoResult = prioritizeTasks(issues, 'cto');
    // critical+blocked+CTO boost > low+todo
    expect(ctoResult[0].id).toBe('b');
  });

  it('QA boosts in_review tasks', () => {
    const issues: PaperclipIssue[] = [
      makeIssue({ id: 'a', status: 'todo', priority: 'high' }),
      makeIssue({ id: 'b', status: 'in_review', priority: 'high' }),
    ];
    const qaResult = prioritizeTasks(issues, 'qa');
    expect(qaResult[0].id).toBe('b'); // in_review boosted for QA
  });

  describe('pickTopTask', () => {
    it('returns null for empty list', () => {
      expect(pickTopTask([])).toBeNull();
    });

    it('returns highest scored task', () => {
      const issues = prioritizeTasks(
        [
          makeIssue({ id: 'a', priority: 'low' }),
          makeIssue({ id: 'b', priority: 'critical' }),
        ],
        'cto'
      );
      const top = pickTopTask(issues);
      expect(top?.id).toBe('b');
    });

    it('returns null when at capacity', () => {
      const issues = prioritizeTasks(
        [makeIssue({ id: 'a', status: 'in_progress', priority: 'critical' })],
        'developer'
      );
      const top = pickTopTask(issues, 1); // maxConcurrent=1, already 1 in_progress
      expect(top).toBeNull();
    });

    it('skips done and cancelled tasks', () => {
      const issues = prioritizeTasks(
        [
          makeIssue({ id: 'a', status: 'done', priority: 'critical' }),
          makeIssue({ id: 'b', status: 'cancelled', priority: 'critical' }),
        ],
        'cto'
      );
      expect(pickTopTask(issues)).toBeNull();
    });
  });
});
