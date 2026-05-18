import { Pool, QueryResult } from 'pg';
import { Task, TaskRow, rowToTask, TaskStatus, TaskPriority, TaskLogEntry, TaskDependency } from '../types';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://localhost:5432/paperclip';

export const pool = new Pool({ connectionString: DATABASE_URL });

export async function query(text: string, params?: unknown[]): Promise<QueryResult> {
  return pool.query(text, params);
}

export async function incrementRetry(taskId: string): Promise<Task | null> {
  const { rows } = await pool.query(
    `UPDATE tasks SET retry_count = retry_count + 1, status = 'queued', last_error = NULL WHERE id = $1 RETURNING *`,
    [taskId]
  );
  return rows.length ? rowToTask(rows[0]) : null;
}

export async function getDependents(dependsOnTaskId: string): Promise<TaskDependency[]> {
  const { rows } = await pool.query(
    `SELECT task_id AS "taskId", depends_on_task_id AS "dependsOnTaskId" FROM task_dependencies WHERE depends_on_task_id = $1`,
    [dependsOnTaskId]
  );
  return rows;
}

// ── Task CRUD ────────────────────────────────────────

export async function createTask(data: {
  title: string;
  description?: string;
  priority?: TaskPriority;
  assigneeId?: string;
  parentId?: string;
  maxRetries?: number;
  scheduledAt?: Date;
  slaDeadline?: Date;
}): Promise<Task> {
  const { rows } = await pool.query(
    `INSERT INTO tasks (title, description, priority, assignee_id, parent_id, max_retries, scheduled_at, sla_deadline, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued')
     RETURNING *`,
    [
      data.title,
      data.description ?? '',
      data.priority ?? 'medium',
      data.assigneeId ?? null,
      data.parentId ?? null,
      data.maxRetries ?? 3,
      data.scheduledAt ?? null,
      data.slaDeadline ?? null,
    ]
  );
  return rowToTask(rows[0]);
}

export async function getTask(taskId: string): Promise<Task | null> {
  const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
  if (rows.length === 0) return null;
  return rowToTask(rows[0]);
}

export async function updateTaskStatus(
  taskId: string,
  status: TaskStatus,
  updates: { startedAt?: Date; completedAt?: Date; lastError?: string } = {}
): Promise<Task | null> {
  const existing = await getTask(taskId);
  if (!existing) return null;

  const setClauses = ['status = $2', 'updated_at = NOW()'];
  const values: unknown[] = [taskId, status];
  let idx = 3;

  if (updates.startedAt) {
    setClauses.push(`started_at = $${idx++}`);
    values.push(updates.startedAt);
  }
  if (updates.completedAt) {
    setClauses.push(`completed_at = $${idx++}`);
    values.push(updates.completedAt);
  }
  if (updates.lastError !== undefined) {
    setClauses.push(`last_error = $${idx++}`);
    values.push(updates.lastError);
  }

  const { rows } = await pool.query(
    `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
    values
  );
  if (rows.length === 0) return null;
  return rowToTask(rows[0]);
}

export async function listTasks(filters: {
  status?: TaskStatus[];
  priority?: TaskPriority;
  assigneeId?: string;
  parentId?: string;
  limit?: number;
  offset?: number;
}): Promise<Task[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (filters.status && filters.status.length > 0) {
    conditions.push(`status = ANY($${idx++})`);
    values.push(filters.status);
  }
  if (filters.priority) {
    conditions.push(`priority = $${idx++}`);
    values.push(filters.priority);
  }
  if (filters.assigneeId) {
    conditions.push(`assignee_id = $${idx++}`);
    values.push(filters.assigneeId);
  }
  if (filters.parentId) {
    conditions.push(`parent_id = $${idx++}`);
    values.push(filters.parentId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;

  const { rows } = await pool.query(
    `SELECT * FROM tasks ${where} ORDER BY priority DESC, created_at ASC LIMIT $${idx++} OFFSET $${idx++}`,
    [...values, limit, offset]
  );
  return rows.map(rowToTask);
}

// ── SLA Deadline Queries ────────────────────────────

/**
 * Find queued or blocked tasks whose SLA deadlines fall within the given
 * window from now. Used by batch SLA reprioritization.
 */
export async function getTasksApproachingSla(
  windowMs: number
): Promise<Task[]> {
  const { rows } = await pool.query(
    `SELECT * FROM tasks
     WHERE sla_deadline IS NOT NULL
       AND sla_deadline <= NOW() + ($1 || ' milliseconds')::INTERVAL
       AND status IN ('queued', 'blocked')
     ORDER BY sla_deadline ASC`,
    [windowMs]
  );
  return rows.map(rowToTask);
}

// ── Dependencies ─────────────────────────────────────

export async function areDependenciesMet(taskId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT COUNT(*) as cnt FROM task_dependencies d
     JOIN tasks t ON t.id = d.depends_on_task_id
     WHERE d.task_id = $1 AND t.status != 'deployed'`,
    [taskId]
  );
  return parseInt(rows[0].cnt, 10) === 0;
}

export async function getUnresolvedDependencies(taskId: string): Promise<{ id: string }[]> {
  const { rows } = await pool.query(
    `SELECT d.depends_on_task_id as id FROM task_dependencies d
     JOIN tasks t ON t.id = d.depends_on_task_id
     WHERE d.task_id = $1 AND t.status != 'deployed'`,
    [taskId]
  );
  return rows;
}

export async function addDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
  await pool.query(
    `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [taskId, dependsOnTaskId]
  );
}

export async function removeDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
  await pool.query(
    `DELETE FROM task_dependencies WHERE task_id = $1 AND depends_on_task_id = $2`,
    [taskId, dependsOnTaskId]
  );
}

export async function getDependencies(taskId: string): Promise<TaskDependency[]> {
  const { rows } = await pool.query(
    `SELECT task_id AS "taskId", depends_on_task_id AS "dependsOnTaskId" FROM task_dependencies WHERE task_id = $1`,
    [taskId]
  );
  return rows;
}

// ── Logs ─────────────────────────────────────────────

export async function writeLog(entry: {
  taskId: string;
  level: string;
  message: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO task_logs (task_id, level, message, metadata) VALUES ($1, $2, $3, $4)`,
    [entry.taskId, entry.level, entry.message, JSON.stringify(entry.metadata ?? {})]
  );
}

export async function getTaskLogs(taskId: string, limit: number = 100): Promise<TaskLogEntry[]> {
  const { rows } = await pool.query(
    `SELECT id, task_id AS "taskId", level, message, metadata, created_at AS "createdAt"
     FROM task_logs WHERE task_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [taskId, limit]
  );
  return rows;
}
