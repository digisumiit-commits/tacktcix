import { pool } from '../db';
import { Task, rowToTask } from '../types';

export async function findBlockedTasks(): Promise<Task[]> {
  const { rows } = await pool.query(`
    SELECT t.* FROM tasks t
    WHERE t.status = 'blocked'
    AND NOT EXISTS (
      SELECT 1 FROM task_dependencies d
      JOIN tasks bt ON bt.id = d.depends_on_task_id
      WHERE d.task_id = t.id
      AND bt.status != 'deployed'
    )
    ORDER BY t.priority DESC, t.created_at ASC
  `);
  return rows.map(rowToTask);
}
