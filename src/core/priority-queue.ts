import Redis from 'ioredis';
import { Task, priorityScore } from '../types';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(REDIS_URL);
  }
  return redis;
}

const QUEUE_KEY = 'task:priority:queue';

export async function enqueueTask(task: Task): Promise<void> {
  const r = getRedis();
  const score = priorityScore(task.priority, task.createdAt);
  await r.zadd(QUEUE_KEY, score, task.id);
}

export async function removeFromQueue(taskId: string): Promise<void> {
  const r = getRedis();
  await r.zrem(QUEUE_KEY, taskId);
}

export async function getQueueLength(): Promise<number> {
  const r = getRedis();
  return r.zcard(QUEUE_KEY);
}

export async function getQueueTasks(limit: number = 20): Promise<string[]> {
  const r = getRedis();
  return r.zrevrange(QUEUE_KEY, 0, limit - 1);
}
