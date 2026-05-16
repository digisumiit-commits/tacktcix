import { describe, it, expect } from 'vitest';
import { VALID_TRANSITIONS, TERMINAL_STATES } from '../src/types';

describe('Task State Model', () => {
  it('all defined states have transition rules', () => {
    const states = ['queued', 'planning', 'executing', 'blocked', 'review', 'approved', 'deployed', 'failed'];
    for (const state of states) {
      expect(VALID_TRANSITIONS[state as keyof typeof VALID_TRANSITIONS]).toBeDefined();
    }
  });

  it('terminal states have no forward transitions to active states', () => {
    for (const terminal of TERMINAL_STATES) {
      const targets = VALID_TRANSITIONS[terminal];
      const activeStates = ['queued', 'planning', 'executing', 'blocked', 'review', 'approved'];
      for (const active of activeStates) {
        expect(targets).not.toContain(active);
      }
    }
  });

  it('failed has queued as valid transition (retry path)', () => {
    expect(VALID_TRANSITIONS.failed).toContain('queued');
  });

  it('every state except deployed can reach failed', () => {
    for (const [state, targets] of Object.entries(VALID_TRANSITIONS)) {
      if (state !== 'deployed' && state !== 'failed') {
        expect(targets).toContain('failed');
      }
    }
  });
});
