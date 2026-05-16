import { TaskStatus, VALID_TRANSITIONS, Task } from '../types';

export class InvalidTransitionError extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`Invalid transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function validateTransition(from: TaskStatus, to: TaskStatus): void {
  const validTargets = VALID_TRANSITIONS[from];
  if (!validTargets.includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  const validTargets = VALID_TRANSITIONS[from];
  return validTargets.includes(to);
}

export function describeTransition(from: TaskStatus, to: TaskStatus): string {
  return `Transition: ${from} → ${to}`;
}

export interface TransitionContext {
  task: Task;
  dependenciesMet: boolean;
  retryCount: number;
  maxRetries: number;
}

export interface TransitionResult {
  status: TaskStatus;
  blocked: boolean;
}

export function resolveNextState(
  ctx: TransitionContext,
  to: TaskStatus
): TransitionResult {
  // When trying to move to executing but dependencies aren't met → block instead
  if (to === 'executing' && !ctx.dependenciesMet) {
    return { status: 'blocked', blocked: true };
  }

  // When failing, check if within retry budget
  if (to === 'failed') {
    if (ctx.retryCount >= ctx.maxRetries) {
      return { status: 'failed', blocked: false };
    }
    return { status: 'failed', blocked: false };
  }

  return { status: to, blocked: false };
}
