import { createTask, getTask, updateTaskStatus, areDependenciesMet, writeLog, getUnresolvedDependencies } from '../db';
import { validateTransition, describeTransition, resolveNextState } from './state-machine';
import { enqueueTask, removeFromQueue } from './priority-queue';
import { scheduleRetry, markFailed } from './retry';
import { Task, TaskStatus, TaskPriority } from '../types';

export class TaskOrchestrator {
  async create(data: {
    title: string;
    description?: string;
    priority?: TaskPriority;
    assigneeId?: string;
    parentId?: string;
    maxRetries?: number;
    scheduledAt?: Date;
  }): Promise<Task> {
    const task = await createTask(data);

    await writeLog({
      taskId: task.id,
      level: 'info',
      message: `Task created with priority ${task.priority}.`,
      metadata: { title: task.title, priority: task.priority },
    });

    if (task.status === 'queued') {
      await enqueueTask(task);
    }

    return task;
  }

  async transition(taskId: string, to: TaskStatus): Promise<Task> {
    const task = await getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    validateTransition(task.status, to);

    const depsMet = await areDependenciesMet(taskId);
    const result = resolveNextState(
      { task, dependenciesMet: depsMet, retryCount: task.retryCount, maxRetries: task.maxRetries },
      to
    );

    if (result.blocked) {
      const unresolved = await getUnresolvedDependencies(taskId);
      await writeLog({
        taskId,
        level: 'warn',
        message: `Cannot transition to executing — ${unresolved.length} dependencies unresolved. Moving to blocked.`,
        metadata: { unresolved: unresolved.map(d => d.id) },
      });
    }

    const updates: { startedAt?: Date; completedAt?: Date } = {};
    if (result.status === 'executing' && !task.startedAt) {
      updates.startedAt = new Date();
    }
    if (result.status === 'deployed') {
      updates.completedAt = new Date();
    }

    const updated = await updateTaskStatus(taskId, result.status, updates);
    if (!updated) throw new Error(`Failed to update task ${taskId}`);

    const description = describeTransition(task.status, result.status);
    await writeLog({
      taskId,
      level: 'info',
      message: description,
      metadata: { from: task.status, to: result.status },
    });

    // Handle queue membership
    if (result.status === 'deployed' || result.status === 'failed') {
      await removeFromQueue(taskId);
    }

    // Auto-retry on failure if within retry budget
    if (result.status === 'failed') {
      const retryResult = await scheduleRetry(taskId);
      if (retryResult) {
        await writeLog({
          taskId,
          level: 'info',
          message: `Auto-retry scheduled. Attempt ${retryResult.retryCount}, delay ${retryResult.delayMs}ms.`,
          metadata: retryResult,
        });
      }
    }

    return updated;
  }

  async get(taskId: string): Promise<Task | null> {
    return getTask(taskId);
  }

  async markFailed(taskId: string, error: string): Promise<void> {
    await markFailed(taskId, error);
    const retryResult = await scheduleRetry(taskId);
    if (retryResult) {
      await writeLog({
        taskId,
        level: 'info',
        message: `Retry scheduled after failure.`,
        metadata: retryResult,
      });
    }
  }
}

export const orchestrator = new TaskOrchestrator();
