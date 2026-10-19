import pool from "../pool/pooler.ts";

export async function findTasksForUser(userId: number, projectId: string | string[]) {
  const result = await pool.query(
    "SELECT * FROM tasks t INNER JOIN projects p on t.project_id = p.id WHERE p.user_id = $1 AND p.id = $2 ",
    [userId, projectId],
  );
  return result.rows;
}

export async function findTaskForUser(userId: number, projectId: string | string[], taskId: string | string[]) {
  const result = await pool.query(
    "SELECT * FROM tasks t INNER JOIN projects p on t.project_id = p.id WHERE p.user_id = $1 AND p.id = $2 AND t.id = $3",
    [userId, projectId, taskId],
  );
  return result.rows;
}

export async function findOwnedProject(projectId: string | string[], userId: number) {
  const result = await pool.query(
    "SELECT * FROM projects WHERE id = $1 AND user_id = $2",
    [projectId, userId],
  );
  return result.rows[0] ?? null;
}

export async function insertTask(title: string, description: string | undefined, status: string, projectId: string | string[]) {
  const result = await pool.query(
    "INSERT INTO tasks (title , description , status , project_id) VALUES ($1 , $2 , $3 , $4) RETURNING * ",
    [title, description, status, projectId],
  );
  return result.rows;
}

export async function updateTaskForUser(update: string, taskId: string | string[], userId: number, projectId: string | string[]) {
  const result = await pool.query(
    "UPDATE tasks t  SET status = $1 FROM projects p WHERE t.project_id = p.id AND t.id = $2 AND p.user_id = $3 AND p.id = $4",
    [update, taskId, userId, projectId],
  );
  return result.rowCount !== 0;
}

export async function deleteTaskForUser(userId: number, projectId: string | string[], taskId: string | string[]) {
  const result = await pool.query(
    "DELETE FROM tasks t USING projects p WHERE t.project_id = p.id AND p.user_id = $1 AND p.id = $2 AND t.id = $3",
    [userId, projectId, taskId],
  );
  return result.rowCount !== 0;
}
