import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import type { Pool } from "pg";

let pool: Pool | undefined;
let findTaskForUser: typeof import("../../repositories/task.repository.ts").findTaskForUser;
let updateTaskForUser: typeof import("../../repositories/task.repository.ts").updateTaskForUser;
let deleteTaskForUser: typeof import("../../repositories/task.repository.ts").deleteTaskForUser;
let repository: typeof import("../../repositories/task.repository.ts");
const originalDatabaseUrl = process.env.DATABASE_URL;
const userIds: number[] = [];
const projectIds: number[] = [];
const taskIds: number[] = [];
let userAId: number;
let userBId: number;
let projectId: number;
let taskId: number;

beforeAll(async () => {
  const localConfig = dotenv.parse(readFileSync(".env.test"));
  const testDatabaseUrl = process.env.TEST_DATABASE_URL || localConfig.TEST_DATABASE_URL;
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required in .env.test");

  // Refuse to create/delete fixtures anywhere except our dedicated local database.
  const url = new URL(testDatabaseUrl);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    decodeURIComponent(url.pathname.slice(1)) !== "oriva_test"
  ) {
    throw new Error("Integration tests require the local oriva_test database");
  }

  // Set this BEFORE loading the real pool; no Jest module mocks are used here.
  process.env.DATABASE_URL = testDatabaseUrl;
  ({ default: pool } = await import("../../pool/pooler.ts"));
  ({ findTaskForUser, updateTaskForUser, deleteTaskForUser } = await import("../../repositories/task.repository.ts"));
  repository = await import("../../repositories/task.repository.ts");
  const result = await pool.query("SELECT current_database() AS database");
  expect(result.rows[0].database).toBe("oriva_test");
});

beforeEach(async () => {
  for (const name of ["Integration user A", "Integration user B"]) {
    const email = `${randomUUID().replace(/-/g, "").slice(0, 16)}@test.local`;
    const result = await pool!.query(
      "INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id",
      [name, email, "test-only-password-hash"],
    );
    userIds.push(result.rows[0].id);
  }
  [userAId, userBId] = userIds;
  const result = await pool!.query(
    "INSERT INTO projects (name, description, status, user_id) VALUES ($1, $2, $3, $4) RETURNING id",
    ["User B project", "Ownership integration fixture", "active", userBId],
  );
  projectId = result.rows[0].id;
  projectIds.push(projectId);
  // A second task verifies that a single-task lookup does not return the whole list.
  for (const title of ["Requested task", "Other task"]) {
    const taskResult = await pool!.query(
      "INSERT INTO tasks (title, description, status, project_id) VALUES ($1, $2, $3, $4) RETURNING id",
      [title, "Task ownership fixture", "on progress", projectId],
    );
    taskIds.push(taskResult.rows[0].id);
  }
  taskId = taskIds[0]!;
});

afterEach(async () => {
  // Runs even after a failed assertion or partially completed beforeEach.
  // Delete only our tracked fixtures, in foreign-key dependency order.
  if (!pool) return;
  if (taskIds.length) {
    await pool.query("DELETE FROM tasks WHERE id = ANY($1::int[])", [taskIds]);
    taskIds.length = 0;
  }
  if (projectIds.length) {
    await pool.query("DELETE FROM projects WHERE id = ANY($1::int[])", [projectIds]);
    projectIds.length = 0;
  }
  if (userIds.length) {
    await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [userIds]);
    userIds.length = 0;
  }
});

afterAll(async () => {
  try {
    await pool?.end();
  } finally {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

test("user A cannot read a task in user B's project", async () => {
  const tasks = await findTaskForUser(userAId, String(projectId), String(taskId));
  expect(tasks).toEqual([]);
});

test("user B can read only the requested task in their own project", async () => {
  const tasks = await findTaskForUser(userBId, String(projectId), String(taskId));
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({
    title: "Requested task",
    project_id: projectId,
    user_id: userBId,
  });
});

test("user A cannot update B's task and both tasks remain unchanged", async () => {
  const updated = await updateTaskForUser("done", String(taskId), userAId, String(projectId));
  expect(updated).toBe(false);

  // Read task columns directly: the joined repository read has overlapping
  // project/task column names, including status.
  const result = await pool!.query(
    "SELECT id, status FROM tasks WHERE id = ANY($1::int[]) ORDER BY id",
    [taskIds],
  );
  expect(result.rows).toEqual([
    { id: taskId, status: "on progress" },
    { id: taskIds[1], status: "on progress" },
  ]);
});

test("user B can update their own task without changing the other task", async () => {
  const updated = await updateTaskForUser("done", String(taskId), userBId, String(projectId));
  expect(updated).toBe(true);

  const result = await pool!.query(
    "SELECT id, status FROM tasks WHERE id = ANY($1::int[]) ORDER BY id",
    [taskIds],
  );
  expect(result.rows).toEqual([
    { id: taskId, status: "done" },
    { id: taskIds[1], status: "on progress" },
  ]);
});

test("user A cannot delete B's task and both tasks remain", async () => {
  const deleted = await deleteTaskForUser(userAId, String(projectId), String(taskId));
  expect(deleted).toBe(false);

  const result = await pool!.query(
    "SELECT id, title, status FROM tasks WHERE id = ANY($1::int[]) ORDER BY id",
    [taskIds],
  );
  expect(result.rows).toEqual([
    { id: taskId, title: "Requested task", status: "on progress" },
    { id: taskIds[1], title: "Other task", status: "on progress" },
  ]);
});

test("user B can delete their own task without deleting the other task", async () => {
  const deleted = await deleteTaskForUser(userBId, String(projectId), String(taskId));
  expect(deleted).toBe(true);

  // Query both fixture IDs so the result proves the target disappeared and
  // the other task is still present and unchanged.
  const result = await pool!.query(
    "SELECT id, title, status FROM tasks WHERE id = ANY($1::int[]) ORDER BY id",
    [taskIds],
  );
  expect(result.rows).toEqual([
    { id: taskIds[1], title: "Other task", status: "on progress" },
  ]);
});


test("task list and lookup preserve the previous flat joined response", async () => {
  const previous = await pool!.query(
    "SELECT * FROM tasks t INNER JOIN projects p ON t.project_id = p.id WHERE p.user_id = $1 AND p.id = $2 ORDER BY t.title",
    [userBId, projectId],
  );
  const rows = await repository.findTasksForUser(userBId, String(projectId));
  expect(rows.sort((a, b) => a.title.localeCompare(b.title))).toEqual(previous.rows);
  expect(await repository.findTasksForUser(userAId, String(projectId))).toEqual([]);
  expect(await repository.findTaskForUser(userBId, String(projectId), String(taskId)))
    .toEqual(previous.rows.filter((row) => row.title === "Requested task"));
});

test("owned-project lookup and cache version reject another owner", async () => {
  expect(await repository.findOwnedProject(String(projectId), userAId)).toBeNull();
  expect(await repository.findTaskCacheVersion(userAId, String(projectId))).toBeNull();
  const previous = await pool!.query("SELECT * FROM projects WHERE id = $1", [projectId]);
  expect(await repository.findOwnedProject(String(projectId), userBId)).toEqual(previous.rows[0]);
  expect(await repository.findTaskCacheVersion(userBId, String(projectId)))
    .toBe(previous.rows[0].task_cache_version);
});

test("task insertion returns its row and advances the live cache version", async () => {
  const before = await repository.findTaskCacheVersion(userBId, String(projectId));
  const rows = await repository.insertTask("New task", undefined, "on progress", String(projectId));
  for (const row of rows) taskIds.push(row.id);
  expect(rows).toHaveLength(1);
  const previous = await pool!.query("SELECT * FROM tasks WHERE id = $1", [rows[0]!.id]);
  expect(rows).toEqual(previous.rows);
  expect(rows[0]).toMatchObject({ title: "New task", description: null, project_id: projectId });
  expect(await repository.findTaskCacheVersion(userBId, String(projectId)))
    .toBe((BigInt(before!) + 1n).toString());
});

test("missing task mutations return false and invalid route IDs do not become valid IDs", async () => {
  expect(await repository.updateTaskForUser("done", "-1", userBId, String(projectId))).toBe(false);
  expect(await repository.deleteTaskForUser(userBId, String(projectId), "-1")).toBe(false);
  await expect(repository.findTaskForUser(userBId, [String(projectId)], String(taskId)))
    .rejects.toThrow("Invalid database ID");
  await expect(repository.findTaskForUser(userBId, String(projectId), "1e1"))
    .rejects.toThrow("Invalid database ID");
});
