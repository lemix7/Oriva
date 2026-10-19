import pool from "../pool/pooler.ts";

export async function getAllProject(userId: number) {
  const results = await pool.query(
    "SELECT * FROM projects WHERE user_id = $1 ORDER BY created_at DESC",
    [userId],
  );

  return results.rows;
}

export async function getProjectsByUserId(userId: number , projectId:number ) {
  const results = await pool.query(
    "SELECT * FROM projects WHERE id = $1 AND user_id = $2",
    [projectId, userId],
  );

  return results.rows[0] ?? null;
}

export async function createProject(
  name: string,
  description: string,
  status: string,
  userId: number,
) {
  const results = await pool.query(
    "INSERT INTO projects (name , description , status , user_id) VALUES ($1 , $2 , $3 , $4) RETURNING *",
    [name, description, status, userId],
  );

  return results.rows[0];
}

export async function updateProject(
  c: string,
  project_id: number,
  userId: number,
) {
  const results = await pool.query(
    "UPDATE projects SET status = $1 WHERE id = $2 AND user_id = $3 RETURNING *",
    [c, project_id, userId],
  );
  return results.rows[0] ?? null;
}

export async function deleteProject(userId: number, project_id: number) {
  const results = await pool.query(
    "DELETE FROM projects WHERE id = $1 AND user_id = $2 RETURNING *",
    [project_id, userId],
  );

  return results.rows[0] ?? null;
}
