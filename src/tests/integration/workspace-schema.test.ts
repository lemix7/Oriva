import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import pg from "pg";

let client: pg.Client | undefined;
let connected = false;
let workspaceId: number;
let userIds: number[];

beforeAll(async () => {
  const config = dotenv.parse(readFileSync(".env.test"));
  const connectionString = process.env.TEST_DATABASE_URL || config.TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TEST_DATABASE_URL is required");
  const url = new URL(connectionString);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.pathname !== "/oriva_test" || url.searchParams.has("host") ||
    url.searchParams.has("hostaddr")
  ) {
    throw new Error("Workspace schema tests require local oriva_test");
  }
  client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
  await client.connect();
  connected = true;
});

beforeEach(async () => {
  // Every fixture and mutation is rolled back, including expected failures.
  await client!.query("BEGIN");
  userIds = [];
  for (const name of ["Owner fixture", "Editor fixture", "Viewer fixture"]) {
    const email = `${randomUUID().replace(/-/g, "").slice(0, 16)}@test.local`;
    const result = await client!.query(
      "INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id",
      [name, email, "test-only-hash"],
    );
    userIds.push(result.rows[0].id);
  }
  const workspace = await client!.query(
    "INSERT INTO workspaces (name, created_by) VALUES ($1, $2) RETURNING id",
    ["Workspace schema fixture", userIds[0]],
  );
  workspaceId = workspace.rows[0].id;
  await client!.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)",
    [workspaceId, userIds[0], "owner"],
  );
});

afterEach(async () => { if (connected) await client!.query("ROLLBACK"); });
afterAll(async () => { await client?.end(); });

test("owner, editor, and viewer can belong to the same workspace", async () => {
  for (const [index, role] of [[1, "editor"], [2, "viewer"]] as const) {
    await client!.query(
      "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)",
      [workspaceId, userIds[index], role],
    );
  }
  const result = await client!.query(
    "SELECT role, created_at, updated_at FROM workspace_members WHERE workspace_id = $1 ORDER BY role",
    [workspaceId],
  );
  expect(result.rows.map(row => row.role)).toEqual(["editor", "owner", "viewer"]);
  for (const row of result.rows) {
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);
  }
});

test("the same user cannot join a workspace twice, even with a different role", async () => {
  await expect(client!.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)",
    [workspaceId, userIds[0], "editor"],
  )).rejects.toMatchObject({ code: "23505", constraint: "workspace_members_workspace_id_user_id_pk" });
});

test("a workspace cannot have a second owner", async () => {
  await expect(client!.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)",
    [workspaceId, userIds[1], "owner"],
  )).rejects.toMatchObject({ code: "23505", constraint: "workspace_members_one_owner" });
});

test("unknown membership roles are rejected by PostgreSQL", async () => {
  await expect(client!.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)",
    [workspaceId, userIds[1], "admin"],
  )).rejects.toMatchObject({ code: "23514", constraint: "workspace_members_role_check" });
});

test("memberships cannot reference a missing user", async () => {
  await client!.query("DELETE FROM users WHERE id = $1", [userIds[1]]);
  await expect(client!.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)",
    [workspaceId, userIds[1], "editor"],
  )).rejects.toMatchObject({ code: "23503", constraint: "workspace_members_user_id_users_id_fk" });
});

test("deleting a workspace removes its memberships", async () => {
  await client!.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
  const result = await client!.query(
    "SELECT user_id FROM workspace_members WHERE workspace_id = $1", [workspaceId],
  );
  expect(result.rows).toEqual([]);
  const owner = await client!.query("SELECT id FROM users WHERE id = $1", [userIds[0]]);
  expect(owner.rows).toHaveLength(1);
});

test("a user account cannot be deleted while it still has a membership", async () => {
  await client!.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)",
    [workspaceId, userIds[1], "editor"],
  );
  await expect(client!.query("DELETE FROM users WHERE id = $1", [userIds[1]]))
    .rejects.toMatchObject({ code: "23503", constraint: "workspace_members_user_id_users_id_fk" });
});
