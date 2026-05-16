import express, { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { orchestrator } from '../core/orchestrator';
import { listTasks, getTaskLogs, addDependency, removeDependency, getDependencies, writeLog } from '../db';
import { getQueueLength, getQueueTasks, getRedis } from '../core/priority-queue';
import { findBlockedTasks } from '../core/dependency-resolver';
import { canTransition } from '../core/state-machine';
import { TaskStatus, TaskPriority, TERMINAL_STATES, AgentRole } from '../types';
import { runHeartbeat } from '../heartbeat/engine';
import { PaperclipClient } from '../api/client';

const router = express.Router();

// Validate UUID
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Error wrapper
function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// Schemas
const createTaskSchema = z.object({
  title: z.string().min(1).max(512),
  description: z.string().max(10000).optional().default(''),
  priority: z.enum(['critical', 'high', 'medium', 'low']).optional().default('medium'),
  assigneeId: z.string().regex(uuidRegex).optional(),
  parentId: z.string().regex(uuidRegex).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  scheduledAt: z.string().datetime().optional(),
});

const transitionSchema = z.object({
  status: z.enum(['planning', 'executing', 'blocked', 'review', 'approved', 'deployed', 'failed', 'queued']),
});

const dependencySchema = z.object({
  dependsOnTaskId: z.string().regex(uuidRegex),
});

const listQuerySchema = z.object({
  status: z.string().optional(),
  priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  assigneeId: z.string().optional(),
  parentId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

// POST /api/tasks — Create
router.post('/tasks', asyncHandler(async (req, res) => {
  const data = createTaskSchema.parse(req.body);
  const task = await orchestrator.create({
    ...data,
    scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : undefined,
  });
  res.status(201).json(task);
}));

// GET /api/tasks — List
router.get('/tasks', asyncHandler(async (req, res) => {
  const filters = listQuerySchema.parse(req.query);
  const statusFilter = filters.status
    ? (filters.status.split(',') as TaskStatus[])
    : undefined;
  const tasks = await listTasks({
    status: statusFilter,
    priority: filters.priority as TaskPriority | undefined,
    assigneeId: filters.assigneeId,
    parentId: filters.parentId,
    limit: filters.limit,
    offset: filters.offset,
  });
  res.json(tasks);
}));

// GET /api/tasks/:id — Get one
router.get('/tasks/:id', asyncHandler(async (req, res) => {
  const task = await orchestrator.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
}));

// PATCH /api/tasks/:id — Update task fields (title, description, priority, etc.)
router.patch('/tasks/:id', asyncHandler(async (req, res) => {
  const { query, getTask } = await import('../db');
  const task = await getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const allowedFields = ['title', 'description', 'priority', 'assigneeId', 'maxRetries', 'scheduledAt'];
  const updates: Record<string, any> = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      if (field === 'assigneeId') updates.assignee_id = req.body[field];
      else if (field === 'maxRetries') updates.max_retries = req.body[field];
      else if (field === 'scheduledAt') updates.scheduled_at = new Date(req.body[field]);
      else updates[field] = req.body[field];
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`);
  const values = Object.values(updates);

  const result = await query(
    `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
    [req.params.id, ...values]
  );

  await writeLog({
    taskId: req.params.id,
    level: 'info',
    message: `Task fields updated: ${Object.keys(updates).join(', ')}.`,
    metadata: updates,
  });

  res.json(result.rows[0]);
}));

// POST /api/tasks/:id/transition — State transition
router.post('/tasks/:id/transition', asyncHandler(async (req, res) => {
  const { status } = transitionSchema.parse(req.body);
  const task = await orchestrator.transition(req.params.id, status);
  res.json(task);
}));

// GET /api/tasks/:id/transitions — List valid next states
router.get('/tasks/:id/transitions', asyncHandler(async (req, res) => {
  const task = await orchestrator.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const allStatuses: TaskStatus[] = ['queued', 'planning', 'executing', 'blocked', 'review', 'approved', 'deployed', 'failed'];
  const valid = allStatuses.filter(s => canTransition(task.status, s));

  res.json({
    current: task.status,
    validTransitions: valid,
  });
}));

// POST /api/tasks/:id/dependencies — Add dependency
router.post('/tasks/:id/dependencies', asyncHandler(async (req, res) => {
  const { dependsOnTaskId } = dependencySchema.parse(req.body);
  if (dependsOnTaskId === req.params.id) {
    return res.status(400).json({ error: 'A task cannot depend on itself' });
  }
  await addDependency(req.params.id, dependsOnTaskId);
  await writeLog({
    taskId: req.params.id,
    level: 'info',
    message: `Dependency added: now blocked by ${dependsOnTaskId}.`,
    metadata: { dependsOnTaskId },
  });
  res.status(201).json({ taskId: req.params.id, dependsOnTaskId });
}));

// DELETE /api/tasks/:id/dependencies/:depId — Remove dependency
router.delete('/tasks/:id/dependencies/:depId', asyncHandler(async (req, res) => {
  await removeDependency(req.params.id, req.params.depId);
  await writeLog({
    taskId: req.params.id,
    level: 'info',
    message: `Dependency removed: no longer blocked by ${req.params.depId}.`,
    metadata: { dependsOnTaskId: req.params.depId },
  });
  res.status(204).send();
}));

// GET /api/tasks/:id/dependencies — List dependencies
router.get('/tasks/:id/dependencies', asyncHandler(async (req, res) => {
  const deps = await getDependencies(req.params.id);
  res.json(deps);
}));

// GET /api/tasks/:id/logs — Task logs
router.get('/tasks/:id/logs', asyncHandler(async (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
  const logs = await getTaskLogs(req.params.id, Math.min(limit, 500));
  res.json(logs);
}));

// GET /api/queue — Queue stats
router.get('/queue', asyncHandler(async (_req, res) => {
  const length = await getQueueLength();
  const topTasks = await getQueueTasks(20);
  res.json({ length, topTasks });
}));

// GET /api/blocked — List tasks whose dependencies resolved
router.get('/blocked', asyncHandler(async (_req, res) => {
  const ready = await findBlockedTasks();
  res.json({ readyToUnblock: ready });
}));

// GET /api/health
router.get('/health', asyncHandler(async (_req, res) => {
  const r = getRedis();
  const redisOk = (await r.ping()) === 'PONG';
  res.json({
    status: 'ok',
    redis: redisOk,
    uptime: process.uptime(),
  });
}));

// POST /api/heartbeat — Run a single heartbeat cycle
router.post('/heartbeat', asyncHandler(async (req, res) => {
  const schema = z.object({
    agentRole: z.enum(['ceo', 'cto', 'developer', 'qa', 'devops', 'uxdesigner', 'securityengineer']).optional().default('cto'),
    agentId: z.string().optional(),
    maxConcurrentTasks: z.number().int().min(1).max(10).optional().default(1),
  });
  const body = schema.parse(req.body);

  const agentId = body.agentId ?? process.env.PAPERCLIP_AGENT_ID ?? 'unknown';
  const companyId = process.env.PAPERCLIP_COMPANY_ID ?? 'unknown';
  const baseUrl = process.env.PAPERCLIP_API_URL ?? 'http://localhost:8000';

  const client = new PaperclipClient({ baseUrl, companyId, agentId });

  const result = await runHeartbeat({
    client,
    agentRole: body.agentRole,
    agentId,
    companyId,
    maxConcurrentTasks: body.maxConcurrentTasks,
  });

  res.json(result);
}));

// Error handler
router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: 'Validation error', details: err.errors });
  }
  if (err.name === 'InvalidTransitionError') {
    return res.status(422).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

export default router;
