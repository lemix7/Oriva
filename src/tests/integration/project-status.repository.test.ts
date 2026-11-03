import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import type { Pool } from "pg";

let pool: Pool | undefined;
let db: typeof import("../../db/index.ts").db;
let repository: typeof import("../../repositories/project-status.repository.ts");
const originalUrl = process.env.DATABASE_URL;
let userId: number | undefined;
let workspaceId: number | undefined;
let projectIds: number[] = [];

beforeAll(async () => {
  const config = dotenv.parse(readFileSync(".env.test"));
  const url = new URL(process.env.TEST_DATABASE_URL || config.TEST_DATABASE_URL);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/oriva_test" || url.searchParams.has("host") || url.searchParams.has("hostaddr")) {
    throw new Error("Status integration tests require local oriva_test");
  }
  process.env.DATABASE_URL = url.href;
  ({ default: pool } = await import("../../pool/pooler.ts"));
  ({ db } = await import("../../db/index.ts"));
  repository = await import("../../repositories/project-status.repository.ts");
});

beforeEach(async () => {
  userId = undefined; workspaceId = undefined; projectIds = [];
  const email = `${randomUUID().replace(/-/g, "").slice(0, 16)}@test.local`;
  userId = (await pool!.query("INSERT INTO users (name, email, password) VALUES ('Status fixture', $1, 'test-only-hash') RETURNING id", [email])).rows[0].id;
  workspaceId = (await pool!.query("INSERT INTO workspaces (name, created_by) VALUES ('Status workspace', $1) RETURNING id", [userId])).rows[0].id;
  for (const name of ["First status project", "Second status project"]) {
    const project = await pool!.query("INSERT INTO projects (workspace_id, user_id, name) VALUES ($1, $2, $3) RETURNING id", [workspaceId, userId, name]);
    projectIds.push(project.rows[0].id);
  }
  await db.transaction(async tx => {
    for (const id of projectIds) await repository.insertDefaultProjectStatuses(tx, id);
  });
});

afterEach(async () => {
  if (!pool) return;
  await pool.query("DELETE FROM tasks WHERE project_id = ANY($1::int[])", [projectIds]);
  await pool.query("DELETE FROM projects WHERE id = ANY($1::int[])", [projectIds]);
  if (workspaceId !== undefined) await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
  if (userId !== undefined) await pool.query("DELETE FROM users WHERE id = $1", [userId]);
});

afterAll(async () => {
  try { await pool?.end(); } finally {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  }
});

test("each project gets separate default statuses with only Done marked complete", async () => {
  const first = await repository.getProjectStatuses(projectIds[0]);
  const second = await repository.getProjectStatuses(projectIds[1]);
  expect(first.map(({ name, position, isDone }) => ({ name, position, isDone }))).toEqual([
    { name: "Backlog", position: 1000, isDone: false }, { name: "In Progress", position: 2000, isDone: false },
    { name: "Review", position: 3000, isDone: false }, { name: "Done", position: 4000, isDone: true },
  ]);
  expect(second).toHaveLength(4);
  expect(first.every(row => row.projectId === projectIds[0] && row.createdAt instanceof Date && row.updatedAt instanceof Date)).toBe(true);
  expect(second.every(row => !first.some(other => other.id === row.id))).toBe(true);
});

test("status reads sort by position and then ID", async () => {
  const rows = await repository.getProjectStatuses(projectIds[0]);
  await pool!.query("UPDATE project_statuses SET position = 1000 WHERE project_id = $1", [projectIds[0]]);
  expect((await repository.getProjectStatuses(projectIds[0])).map(row => row.id)).toEqual(rows.map(row => row.id).sort((a, b) => a - b));
  await pool!.query("UPDATE project_statuses SET position = 0 WHERE id = $1", [rows[3].id]);
  expect((await repository.getProjectStatuses(projectIds[0]))[0].id).toBe(rows[3].id);
});

test("status names are unique within a project", async () => {
  await expect(pool!.query("INSERT INTO project_statuses (project_id, name, position) VALUES ($1, 'Done', 5000)", [projectIds[0]]))
    .rejects.toMatchObject({ code: "23505", constraint: "project_statuses_project_name_unique" });
  expect(await repository.getProjectStatuses(projectIds[0])).toHaveLength(4);
});

test("a task cannot insert or update a status from another project", async () => {
  const own = (await repository.getProjectStatuses(projectIds[0]))[0];
  const foreign = (await repository.getProjectStatuses(projectIds[1]))[0];
  await expect(pool!.query("INSERT INTO tasks (project_id, title, status_id) VALUES ($1, 'Invalid task', $2)", [projectIds[0], foreign.id]))
    .rejects.toMatchObject({ code: "23503", constraint: "tasks_status_project_fk" });
  const task = (await pool!.query("INSERT INTO tasks (project_id, title, status_id) VALUES ($1, 'Valid task', $2) RETURNING id", [projectIds[0], own.id])).rows[0];
  await expect(pool!.query("UPDATE tasks SET status_id = $1 WHERE id = $2", [foreign.id, task.id]))
    .rejects.toMatchObject({ code: "23503", constraint: "tasks_status_project_fk" });
  expect((await pool!.query("SELECT status_id FROM tasks WHERE id = $1", [task.id])).rows).toEqual([{ status_id: own.id }]);
});

test("referenced statuses cannot be deleted but unused statuses can", async () => {
  const rows = await repository.getProjectStatuses(projectIds[0]);
  await pool!.query("INSERT INTO tasks (project_id, title, status_id) VALUES ($1, 'Status task', $2)", [projectIds[0], rows[0].id]);
  await expect(pool!.query("DELETE FROM project_statuses WHERE id = $1", [rows[0].id]))
    .rejects.toMatchObject({ code: "23503", constraint: "tasks_status_project_fk" });
  await pool!.query("DELETE FROM project_statuses WHERE id = $1", [rows[1].id]);
  expect(await repository.getProjectStatuses(projectIds[0])).toHaveLength(3);
});

test("deleting an empty project removes its statuses without touching another project", async () => {
  const other = await repository.getProjectStatuses(projectIds[1]);
  await pool!.query("DELETE FROM projects WHERE id = $1", [projectIds[0]]);
  expect(await repository.getProjectStatuses(projectIds[0])).toEqual([]);
  expect(await repository.getProjectStatuses(projectIds[1])).toEqual(other);
});

test("migration seeds four default statuses for every existing project", async () => {
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE TEMP TABLE projects (id integer PRIMARY KEY) ON COMMIT DROP");
    await client.query("CREATE TEMP TABLE project_statuses (LIKE public.project_statuses INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP");
    await client.query("ALTER TABLE pg_temp.project_statuses ALTER COLUMN id DROP DEFAULT");
    await client.query("ALTER TABLE pg_temp.project_statuses ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY");
    await client.query("INSERT INTO pg_temp.projects VALUES (101), (102)");
    const migration = readFileSync("drizzle/0007_project-statuses.sql", "utf8");
    const seedStart = migration.indexOf('INSERT INTO "project_statuses"');
    expect(seedStart).toBeGreaterThanOrEqual(0);
    await client.query(migration.slice(seedStart));
    const rows = (await client.query("SELECT project_id, name, position, is_done FROM pg_temp.project_statuses ORDER BY project_id, position")).rows;
    expect(rows).toEqual([101, 102].flatMap(project_id => [
      { project_id, name: "Backlog", position: 1000, is_done: false },
      { project_id, name: "In Progress", position: 2000, is_done: false },
      { project_id, name: "Review", position: 3000, is_done: false },
      { project_id, name: "Done", position: 4000, is_done: true },
    ]));
  } finally {
    try { await client.query("ROLLBACK"); } finally { client.release(); }
  }
});

test("custom status inserts return persisted fields and default isDone to false", async () => {
  const status = await db.transaction(tx => repository.insertProjectStatus(tx, projectIds[0], { name: "Testing", position: 5000 }));
  expect(status).toMatchObject({ projectId: projectIds[0], name: "Testing", position: 5000, isDone: false });
  expect(status.createdAt).toBeInstanceOf(Date);
  expect(status.updatedAt).toBeInstanceOf(Date);
  const completed = await db.transaction(tx => repository.insertProjectStatus(tx, projectIds[0], { name: "Released", position: 6000, isDone: true }));
  expect(completed.isDone).toBe(true);
  expect((await repository.getProjectStatuses(projectIds[0])).slice(-2)).toEqual([status, completed]);
});

test("duplicate insertion returns undefined and the same transaction remains usable", async () => {
  await db.transaction(async tx => {
    expect(await repository.insertProjectStatus(tx, projectIds[0], { name: "Done", position: 5000 })).toBeUndefined();
    expect(await repository.insertProjectStatus(tx, projectIds[0], { name: "Testing", position: 5000 })).toMatchObject({ name: "Testing" });
    expect(await repository.getProjectStatuses(projectIds[0], tx)).toHaveLength(5);
  });
  expect(await repository.getProjectStatuses(projectIds[0])).toHaveLength(5);
  expect(await repository.getProjectStatuses(projectIds[1])).toHaveLength(4);
});

test("custom status writes roll back with their enclosing transaction", async () => {
  const before = await repository.getProjectStatuses(projectIds[0]);
  await expect(db.transaction(async tx => {
    await repository.insertProjectStatus(tx, projectIds[0], { name: "Rolled back", position: 5000 });
    throw new Error("Force rollback");
  })).rejects.toThrow("Force rollback");
  expect(await repository.getProjectStatuses(projectIds[0])).toEqual(before);
});

test("unrelated foreign-key errors are not treated as duplicate names", async () => {
  await expect(db.transaction(tx => repository.insertProjectStatus(tx, -1, { name: "Testing", position: 5000 })))
    .rejects.toMatchObject({ cause: { code: "23503" } });
});

test("status edits persist allowed fields, preserve creation time and scope to the project", async () => {
  const own = (await repository.getProjectStatuses(projectIds[0]))[0];
  const other = await repository.getProjectStatuses(projectIds[1]);
  await pool!.query("UPDATE project_statuses SET updated_at = '2000-01-01' WHERE id = $1", [own.id]);
  const updated = await db.transaction(tx => repository.updateProjectStatus(tx, projectIds[0], own.id, { name: "Changed", position: 0, isDone: true }));
  expect(updated).toEqual({ ...own, name: "Changed", position: 0, isDone: true, updatedAt: expect.any(Date) });
  expect(updated.updatedAt.getTime()).toBeGreaterThan(new Date("2000-01-01").getTime());
  const renamed = await db.transaction(tx => repository.updateProjectStatus(tx, projectIds[0], own.id, { name: "Renamed" }));
  expect(renamed).toMatchObject({ name: "Renamed", position: 0, isDone: true, createdAt: own.createdAt });
  expect(await repository.getProjectStatuses(projectIds[1])).toEqual(other);
});

test("status edits return undefined for missing or mismatched project/status IDs", async () => {
  const own = (await repository.getProjectStatuses(projectIds[0]))[0];
  const before = await repository.getProjectStatuses(projectIds[0]);
  for (const [projectId, statusId] of [[projectIds[1], own.id], [projectIds[0], -1], [-1, own.id]]) {
    expect(await db.transaction(tx => repository.updateProjectStatus(tx, projectId, statusId, { name: "Wrong status" }))).toBeUndefined();
  }
  expect(await repository.getProjectStatuses(projectIds[0])).toEqual(before);
});

test("duplicate-name edits fail atomically, while retaining the current name is allowed", async () => {
  const before = await repository.getProjectStatuses(projectIds[0]);
  await expect(db.transaction(tx => repository.updateProjectStatus(tx, projectIds[0], before[0].id, { name: before[1].name, position: 0, isDone: true })))
    .rejects.toMatchObject({ cause: { code: "23505", constraint: "project_statuses_project_name_unique" } });
  expect(await repository.getProjectStatuses(projectIds[0])).toEqual(before);
  expect(await db.transaction(tx => repository.updateProjectStatus(tx, projectIds[0], before[0].id, { name: before[0].name, position: 0 }))).toMatchObject({ id: before[0].id, position: 0 });
});

test("status edits roll back when the enclosing transaction fails", async () => {
  const before = await repository.getProjectStatuses(projectIds[0]);
  await expect(db.transaction(async tx => {
    await repository.updateProjectStatus(tx, projectIds[0], before[0].id, { name: "Rolled back", isDone: true });
    throw new Error("Force rollback");
  })).rejects.toThrow("Force rollback");
  expect(await repository.getProjectStatuses(projectIds[0])).toEqual(before);
});

test("deletion removes only the requested status in the specified project", async () => {
  const first = await repository.getProjectStatuses(projectIds[0]);
  const other = await repository.getProjectStatuses(projectIds[1]);
  expect(await db.transaction(tx => repository.deleteProjectStatus(tx, projectIds[1], first[0].id))).toBeUndefined();
  expect(await db.transaction(tx => repository.deleteProjectStatus(tx, projectIds[0], -1))).toBeUndefined();
  expect(await db.transaction(tx => repository.deleteProjectStatus(tx, projectIds[0], first[0].id))).toEqual({ id: first[0].id });
  expect(await repository.getProjectStatuses(projectIds[0])).toEqual(first.slice(1));
  expect(await repository.getProjectStatuses(projectIds[1])).toEqual(other);
});

test("task-reference checks scope both IDs and allow deletion after tasks move", async () => {
  const statuses = await repository.getProjectStatuses(projectIds[0]);
  const task = (await pool!.query("INSERT INTO tasks (project_id, title, status_id) VALUES ($1, 'Referenced status task', $2) RETURNING id", [projectIds[0], statuses[0].id])).rows[0];
  expect(await db.transaction(tx => repository.projectStatusHasTasks(tx, projectIds[0], statuses[0].id))).toBe(true);
  expect(await db.transaction(tx => repository.projectStatusHasTasks(tx, projectIds[1], statuses[0].id))).toBe(false);
  expect(await db.transaction(tx => repository.projectStatusHasTasks(tx, projectIds[0], statuses[1].id))).toBe(false);
  await expect(db.transaction(tx => repository.deleteProjectStatus(tx, projectIds[0], statuses[0].id)))
    .rejects.toMatchObject({ cause: { code: "23503", constraint: "tasks_status_project_fk" } });
  await pool!.query("UPDATE tasks SET status_id = $1 WHERE id = $2", [statuses[1].id, task.id]);
  expect(await db.transaction(tx => repository.projectStatusHasTasks(tx, projectIds[0], statuses[0].id))).toBe(false);
  expect(await db.transaction(tx => repository.deleteProjectStatus(tx, projectIds[0], statuses[0].id))).toEqual({ id: statuses[0].id });
});

test("status deletions roll back with their enclosing transaction", async () => {
  const before = await repository.getProjectStatuses(projectIds[0]);
  await expect(db.transaction(async tx => {
    await repository.deleteProjectStatus(tx, projectIds[0], before[0].id);
    throw new Error("Force deletion rollback");
  })).rejects.toThrow("Force deletion rollback");
  expect(await repository.getProjectStatuses(projectIds[0])).toEqual(before);
});
