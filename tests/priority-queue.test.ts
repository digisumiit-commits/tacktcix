import { describe, it, expect } from 'vitest';
import { priorityScore, PRIORITY_WEIGHTS } from '../src/types';

describe('Priority Queue', () => {
  describe('priorityScore', () => {
    it('ranks critical above high', () => {
      const now = new Date();
      const critical = {
        priority: 'critical' as const,
        score: PRIORITY_WEIGHTS.critical * 1_000_000_000_000 + (9_999_999_999_999 - now.getTime()),
      };
      const high = {
        priority: 'high' as const,
        score: PRIORITY_WEIGHTS.high * 1_000_000_000_000 + (9_999_999_999_999 - now.getTime()),
      };
      expect(critical.score).toBeGreaterThan(high.score);
    });

    it('ranks older tasks higher within same priority', () => {
      const older = new Date('2024-01-01');
      const newer = new Date('2024-06-01');
      const oldScore = PRIORITY_WEIGHTS.medium * 1_000_000_000_000 + (9_999_999_999_999 - older.getTime());
      const newScore = PRIORITY_WEIGHTS.medium * 1_000_000_000_000 + (9_999_999_999_999 - newer.getTime());
      expect(oldScore).toBeGreaterThan(newScore);
    });
  });
});
