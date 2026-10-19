import pool from "../pool/pooler.ts";

export async function findAllUsers() {
  const result = await pool.query("SELECT * FROM users ORDER BY id ASC"
  );
  return result.rows;
}

export async function findUsersById(id: number) {
  const result = await pool.query("SELECT * FROM users WHERE id = $1", [id]
  );
  return result.rows;
}

export async function insertUser(name: string, email: string, pass: string, key: string | null) {
  const result = await pool.query(
    "INSERT INTO users (name , email , password , profile_pic_key) VALUES ($1, $2 , $3 , $4) RETURNING *",
    [name, email, pass, key],
  );
  return result.rows[0];
}

export async function updateUser(name: string, email: string, id: number) {
  const result = await pool.query(
    "UPDATE users SET name = $1 , email = $2 WHERE id = $3",
    [name, email, id],
  );
  return result.rowCount !== 0;
}

export async function deleteUser(id: number) {
  const result = await pool.query("DELETE FROM users WHERE $1 = id", [id]
  );
  return result.rowCount !== 0;
}
