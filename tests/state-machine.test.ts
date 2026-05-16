import { describe, it, expect } from 'vitest';
import {
  validateTransition,
  canTransition,
  InvalidTransitionError,
  resolveNextState,
} from '../src/core/state-machine';
import { Task } from '../src/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    title: 'Test',
    description: '',
    status: 'queued',
    priority: 'medium',
    assigneeId: null,
    parentId: null,
    retryCount: 0,
    maxRetries: 3,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    scheduledAt: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe('State Machine', () => {
  describe('validateTransition', () => {
    it('allows queued → planning', () => {
      expect(() => validateTransition('queued', 'planning')).not.toThrow();
    });

    it('allows planning → executing', () => {
      expect(() => validateTransition('planning', 'executing')).not.toThrow();
    });

    it('allows executing → blocked', () => {
      expect(() => validateTransition('executing', 'blocked')).not.toThrow();
    });

    it('allows executing → review', () => {
      expect(() => validateTransition('executing', 'review')).not.toThrow();
    });

    it('allows blocked → executing', () => {
      expect(() => validateTransition('blocked', 'executing')).not.toThrow();
    });

    it('allows review → approved', () => {
      expect(() => validateTransition('review', 'approved')).not.toThrow();
    });

    it('allows review → executing (changes requested)', () => {
      expect(() => validateTransition('review', 'executing')).not.toThrow();
    });

    it('allows approved → deployed', () => {
      expect(() => validateTransition('approved', 'deployed')).not.toThrow();
    });

    it('rejects queued → deployed (skip states)', () => {
      expect(() => validateTransition('queued', 'deployed')).toThrow(InvalidTransitionError);
    });

    it('rejects deployed → executing (terminal)', () => {
      expect(() => validateTransition('deployed', 'executing')).toThrow(InvalidTransitionError);
    });
  });

  describe('canTransition', () => {
    it('returns true for valid transitions', () => {
      expect(canTransition('queued', 'planning')).toBe(true);
    });

    it('returns false for invalid transitions', () => {
      expect(canTransition('deployed', 'planning')).toBe(false);
    });
  });

  describe('resolveNextState', () => {
    it('blocks executing transition when dependencies are unmet', () => {
      const ctx = {
        task: makeTask({ status: 'planning' }),
        dependenciesMet: false,
        retryCount: 0,
        maxRetries: 3,
      };
      const result = resolveNextState(ctx, 'executing');
      expect(result.status).toBe('blocked');
      expect(result.blocked).toBe(true);
    });

    it('allows executing when dependencies are met', () => {
      const ctx = {
        task: makeTask({ status: 'planning' }),
        dependenciesMet: true,
        retryCount: 0,
        maxRetries: 3,
      };
      const result = resolveNextState(ctx, 'executing');
      expect(result.status).toBe('executing');
    });

    it('marks as failed when within retry budget', () => {
      const ctx = {
        task: makeTask({ status: 'executing', retryCount: 1, maxRetries: 3 }),
        dependenciesMet: true,
        retryCount: 1,
        maxRetries: 3,
      };
      const result = resolveNextState(ctx, 'failed');
      expect(result.status).toBe('failed');
    });
  });
});
