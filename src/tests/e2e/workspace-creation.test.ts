import { afterAll, afterEach, beforeAll, beforeEach, expect, jest, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import loginRateLimit from "../../middleware/login-rate-limit.ts";

// Keep the HTTP/auth/service/database flow real, without external delivery/storage.
const queueEmail = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule("../../queue/email.que.js", () => ({
  default: { add: queueEmail },
}));
jest.unstable_mockModule("../../adapters/profile-pic-storage.adapter.js", () => ({
  uploadProfilePicture: jest.fn(),
  deleteProfilePicture: jest.fn(),
}));
jest.unstable_mockModule("../../config/task-cache.js", () => ({
  default: { get: jest.fn(), set: jest.fn() },
}));

const requestLog = jest.spyOn(console, "log").mockImplementation(() => {});
const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalSecret = process.env.SECRET_KEY;
const password = "workspace-test-password";
let passwordHash: string;
let pool: Pool | undefined;
let server: Server | undefined;
let baseUrl: string;
let ownerEmail: string;
let userIds: number[] = [];

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
    throw new Error("Workspace HTTP tests require local oriva_test");
  }
  process.env.DATABASE_URL = connectionString;
  process.env.SECRET_KEY = "workspace-http-test-secret";
  ({ default: pool } = await import("../../pool/pooler.ts"));
  passwordHash = await bcrypt.hash(password, 8);
  const { default: app } = await import("../../app.ts");
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve());
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  queueEmail.mockReset().mockResolvedValue(undefined);
  // Each test has its own login allowance; keep the real login/auth flow.
  loginRateLimit.resetKey("127.0.0.1");
  userIds = [];
  errorLog.mockClear();
  for (const name of ["Workspace owner fixture", "Workspace other fixture"]) {
    const email = `${randomUUID().replace(/-/g, "").slice(0, 16)}@test.local`;
    const result = await pool!.query(
      "INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id",
      [name, email, passwordHash],
    );
    if (userIds.length === 0) ownerEmail = email;
    userIds.push(result.rows[0].id);
  }
});

afterEach(async () => {
  if (!pool || userIds.length === 0) return;
  // Only remove records belonging to the accounts created by this test.
  await pool.query(
    `DELETE FROM tasks WHERE project_id IN (
       SELECT p.id FROM projects p INNER JOIN workspaces w ON p.workspace_id = w.id
       WHERE w.created_by = ANY($1::int[])
     )`, [userIds],
  );
  await pool.query(
    "DELETE FROM projects WHERE workspace_id IN (SELECT id FROM workspaces WHERE created_by = ANY($1::int[]))",
    [userIds],
  );
  await pool.query("DELETE FROM workspaces WHERE created_by = ANY($1::int[])", [userIds]);
  await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [userIds]);
  userIds = [];
});

afterAll(async () => {
  try {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve());
      });
    }
  } finally {
    try { await pool?.end(); } finally {
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
      if (originalSecret === undefined) delete process.env.SECRET_KEY;
      else process.env.SECRET_KEY = originalSecret;
      requestLog.mockRestore();
      errorLog.mockRestore();
    }
  }
});

async function login(email = ownerEmail): Promise<string> {
  const response = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.token).toEqual(expect.any(String));
  return body.token;
}

async function create(body: unknown, token?: string) {
  return fetch(`${baseUrl}/workspaces`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

async function list(token: string, afterId?: number) {
  const url = new URL("/workspaces", baseUrl);

  if (afterId !== undefined) {
    url.searchParams.set("afterId", afterId.toString());
  }

  return fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
}

async function expectNoWorkspace() {
  const result = await pool!.query(
    "SELECT count(*)::int AS count FROM workspaces WHERE created_by = ANY($1::int[])",
    [userIds],
  );
  expect(result.rows[0].count).toBe(0);
}

async function changeRole(workspaceId: number | string, memberId: number | string, role: unknown, token: string) {
  return fetch(`${baseUrl}/workspaces/${workspaceId}/members/${memberId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ role }),
    signal: AbortSignal.timeout(5000),
  });
}

async function membershipSnapshot(workspaceId: number) {
  const result = await pool!.query(
    "SELECT user_id, role, updated_at FROM workspace_members WHERE workspace_id = $1 ORDER BY user_id",
    [workspaceId],
  );
  return result.rows;
}

async function removeMember(workspaceId: number | string, memberId: number | string, token: string) {
  return fetch(`${baseUrl}/workspaces/${workspaceId}/members/${memberId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
}

test("creation trims the name and assigns ownership to the authenticated user", async () => {
  const token = await login();
  const response = await create({
    name: "  Team workspace  ",
    createdBy: userIds[1],
    userId: userIds[1],
    role: "viewer",
  }, token);
  const body = await response.json();
  expect(response.status).toBe(201);
  expect(body).toEqual({ data: expect.objectContaining({
    id: expect.any(Number), name: "Team workspace", createdBy: userIds[0],
  }) });
  const memberships = await pool!.query(
    "SELECT user_id, role FROM workspace_members WHERE workspace_id = $1", [body.data.id],
  );
  expect(memberships.rows).toEqual([{ user_id: userIds[0], role: "owner" }]);
});

test("a member can read their workspace", async () => {
  const token = await login();
  const created = await create({ name: "Team workspace" }, token);

  expect(created.status).toBe(201);
  const { data: workspace } = await created.json();

  const response = await fetch(
    `${baseUrl}/workspaces/${workspace.id}`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: workspace });
});

test("a non-member cannot read another user's workspace", async () => {
  const token = await login();

  const result = await pool!.query(
    "INSERT INTO workspaces (name, created_by) VALUES ($1, $2) RETURNING id",
    ["Private workspace", userIds[1]],
  );
  const workspaceId = result.rows[0].id;

  await pool!.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)",
    [workspaceId, userIds[1], "owner"],
  );

  const response = await fetch(
    `${baseUrl}/workspaces/${workspaceId}`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    },
  );

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: {
      code: "NOT_FOUND",
      message: "Workspace not found",
      requestId: response.headers.get("x-request-id"),
    },
  });
});

test("rejects invalid workspace IDs", async () => {
  const token = await login();

  for (const id of ["abc", "0", "-1", "1.5", "2147483648"]) {
    const response = await fetch(`${baseUrl}/workspaces/${id}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });

    expect(response.status).toBe(422);

    const body = await response.json();
    expect(body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "wid" }),
      ]),
    );
  }
});

test("a member can list workspace teammates and roles", async () => {
  const token = await login();
  const created = await create({ name: "Team workspace" }, token);

  expect(created.status).toBe(201);
  const { data: workspace } = await created.json();

  await pool!.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)",
    [workspace.id, userIds[1], "viewer"],
  );

  const response = await fetch(
    `${baseUrl}/workspaces/${workspace.id}/members`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: [
      {
        userId: userIds[0],
        name: "Workspace owner fixture",
        role: "owner",
      },
      {
        userId: userIds[1],
        name: "Workspace other fixture",
        role: "viewer",
      },
    ],
    page: { nextCursor: null },
  });
});

test("a non-member cannot list workspace members", async () => {
  const token = await login();

  const result = await pool!.query(
    "INSERT INTO workspaces (name, created_by) VALUES ($1, $2) RETURNING id",
    ["Private workspace", userIds[1]],
  );
  const workspaceId = result.rows[0].id;

  await pool!.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)",
    [workspaceId, userIds[1], "owner"],
  );

  const response = await fetch(
    `${baseUrl}/workspaces/${workspaceId}/members`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    },
  );

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: {
      code: "NOT_FOUND",
      message: "Workspace not found",
      requestId: response.headers.get("x-request-id"),
    },
  });
});

test("paginates workspace members without repeating or skipping anyone", async () => {
  const token = await login();
  const created = await create({ name: "Paginated team" }, token);
  expect(created.status).toBe(201);
  const { data: workspace } = await created.json();

  const prefix = randomUUID().replace(/-/g, "").slice(0, 12);
  const inserted = await pool!.query(
    `INSERT INTO users (name, email, password)
     SELECT 'Pagination member', $1 || n::text || '@test.local', $2
     FROM generate_series(1, 20) AS n RETURNING id`,
    [prefix, passwordHash],
  );
  const memberIds: number[] = inserted.rows.map((row) => row.id);
  userIds.push(...memberIds);
  await pool!.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role)
     SELECT $1, member_id, 'viewer' FROM unnest($2::int[]) AS member_id`,
    [workspace.id, memberIds],
  );

  const membersUrl = `${baseUrl}/workspaces/${workspace.id}/members`;
  const options = () => ({
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  const firstResponse = await fetch(membersUrl, options());
  expect(firstResponse.status).toBe(200);
  const first = await firstResponse.json();
  expect(first.data).toHaveLength(20);
  expect(first.page.nextCursor).toBe(first.data[19].userId);

  const secondResponse = await fetch(
    `${membersUrl}?afterUserId=${first.page.nextCursor}`, options(),
  );
  expect(secondResponse.status).toBe(200);
  const second = await secondResponse.json();
  expect(second.data).toHaveLength(1);
  expect(second.page.nextCursor).toBeNull();
  expect([...first.data, ...second.data].map((member) => member.userId))
    .toEqual([userIds[0], ...memberIds].sort((a, b) => a - b));
});

test("a viewer can read the workspace member list", async () => {
  const ownerToken = await login();
  const created = await create({ name: "Viewer team" }, ownerToken);
  expect(created.status).toBe(201);
  const { data: workspace } = await created.json();
  await pool!.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')",
    [workspace.id, userIds[1]],
  );
  const viewer = await pool!.query("SELECT email FROM users WHERE id = $1", [userIds[1]]);
  const viewerToken = await login(viewer.rows[0].email);

  const response = await fetch(`${baseUrl}/workspaces/${workspace.id}/members`, {
    headers: { authorization: `Bearer ${viewerToken}` },
    signal: AbortSignal.timeout(5000),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: [
      { userId: userIds[0], name: "Workspace owner fixture", role: "owner" },
      { userId: userIds[1], name: "Workspace other fixture", role: "viewer" },
    ],
    page: { nextCursor: null },
  });
});

test("rejects invalid member-list cursors", async () => {
  const token = await login();
  const created = await create({ name: "Cursor validation team" }, token);
  expect(created.status).toBe(201);
  const { data: workspace } = await created.json();

  for (const cursor of ["abc", "-1", "1.5", "2147483648"]) {
    const response = await fetch(
      `${baseUrl}/workspaces/${workspace.id}/members?afterUserId=${cursor}`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      },
    );
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "afterUserId" }),
    ]));
  }
});

test("the owner can change a viewer to an editor and persist the role", async () => {
  const token = await login();
  const created = await create({ name: "Role change team" }, token);
  expect(created.status).toBe(201);
  const { data: workspace } = await created.json();

  await pool!.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')",
    [workspace.id, userIds[1]],
  );

  const response = await fetch(
    `${baseUrl}/workspaces/${workspace.id}/members/${userIds[1]}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ role: "editor" }),
      signal: AbortSignal.timeout(5000),
    },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: { workspaceId: workspace.id, userId: userIds[1], role: "editor" },
  });

  const saved = await pool!.query(
    "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
    [workspace.id, userIds[1]],
  );
  expect(saved.rows).toEqual([{ role: "editor" }]);
});

test.each(["editor", "viewer"] as const)(
  "a %s cannot change member roles",
  async (role) => {
    const ownerToken = await login();
    const created = await create({ name: "Protected team" }, ownerToken);
    expect(created.status).toBe(201);
    const { data: workspace } = await created.json();
    await pool!.query(
      "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)",
      [workspace.id, userIds[1], role],
    );
    const other = await pool!.query("SELECT email FROM users WHERE id = $1", [userIds[1]]);
    const token = await login(other.rows[0].email);
    const before = await membershipSnapshot(workspace.id);

    const response = await changeRole(
      workspace.id, userIds[1], role === "editor" ? "viewer" : "editor", token,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Only owners can change member roles",
        requestId: response.headers.get("x-request-id"),
      },
    });
    expect(await membershipSnapshot(workspace.id)).toEqual(before);
  },
);

test("a non-member cannot change workspace roles", async () => {
  const ownerToken = await login();
  const created = await create({ name: "Private role team" }, ownerToken);
  expect(created.status).toBe(201);
  const { data: workspace } = await created.json();
  const other = await pool!.query("SELECT email FROM users WHERE id = $1", [userIds[1]]);
  const token = await login(other.rows[0].email);
  const before = await membershipSnapshot(workspace.id);

  const response = await changeRole(workspace.id, userIds[0], "viewer", token);

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: {
      code: "NOT_FOUND",
      message: "Workspace not found",
      requestId: response.headers.get("x-request-id"),
    },
  });
  expect(await membershipSnapshot(workspace.id)).toEqual(before);
});

test("the owner cannot demote themselves through a role change", async () => {
  const token = await login();
  const created = await create({ name: "Owner protection team" }, token);
  expect(created.status).toBe(201);
  const { data: workspace } = await created.json();
  const before = await membershipSnapshot(workspace.id);

  const response = await changeRole(workspace.id, userIds[0], "viewer", token);

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: {
      code: "OWNERSHIP_TRANSFER_REQUIRED",
      message: "Use ownership transfer to change the owner",
      requestId: response.headers.get("x-request-id"),
    },
  });
  expect(await membershipSnapshot(workspace.id)).toEqual(before);
});

test("the role endpoint rejects assigning owner", async () => {
  const token = await login();
  const created = await create({ name: "Ownership validation team" }, token);
  expect(created.status).toBe(201);
  const { data: workspace } = await created.json();
  await pool!.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')",
    [workspace.id, userIds[1]],
  );
  const before = await membershipSnapshot(workspace.id);

  const response = await changeRole(workspace.id, userIds[1], "owner", token);

  expect(response.status).toBe(422);
  const body = await response.json();
  expect(body.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: "role" }),
  ]));
  expect(await membershipSnapshot(workspace.id)).toEqual(before);
});

test("the owner can change an editor back to viewer", async () => {
  const token = await login();
  const created = await create({ name: "Editor demotion team" }, token);
  expect(created.status).toBe(201);
  const { data: workspace } = await created.json();
  await pool!.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'editor')",
    [workspace.id, userIds[1]],
  );

  const response = await changeRole(workspace.id, userIds[1], "viewer", token);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: { workspaceId: workspace.id, userId: userIds[1], role: "viewer" },
  });
  expect(await membershipSnapshot(workspace.id)).toEqual([
    expect.objectContaining({ user_id: userIds[0], role: "owner" }),
    expect.objectContaining({ user_id: userIds[1], role: "viewer" }),
  ]);
});

test("changing a user outside the workspace returns 404", async () => {
  const token = await login();
  const created = await create({ name: "Missing member team" }, token);
  expect(created.status).toBe(201);
  const { data: workspace } = await created.json();
  const before = await membershipSnapshot(workspace.id);

  const response = await changeRole(workspace.id, userIds[1], "editor", token);

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: {
      code: "NOT_FOUND",
      message: "Workspace member not found",
      requestId: response.headers.get("x-request-id"),
    },
  });
  expect(await membershipSnapshot(workspace.id)).toEqual(before);
});

test("role changes reject invalid IDs and invalid or missing roles", async () => {
  const token = await login();
  const created = await create({ name: "Role validation team" }, token);
  expect(created.status).toBe(201);
  const { data: workspace } = await created.json();
  await pool!.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')",
    [workspace.id, userIds[1]],
  );
  const before = await membershipSnapshot(workspace.id);

  for (const invalidId of ["abc", "0", "-1", "1.5", "2147483648"]) {
    for (const field of ["wid", "uid"]) {
      const response = await changeRole(
        field === "wid" ? invalidId : workspace.id,
        field === "uid" ? invalidId : userIds[1],
        "editor", token,
      );
      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ field }),
      ]));
    }
  }

  // Undefined serializes to an empty body object, exercising the required rule.
  for (const role of ["admin", "", null, 123, undefined]) {
    const response = await changeRole(workspace.id, userIds[1], role, token);
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "role" }),
    ]));
  }
  expect(await membershipSnapshot(workspace.id)).toEqual(before);
});

test("role changes wait for the workspace lock before updating", async () => {
  const token = await login();
  const created = await create({ name: "Locked role team" }, token);
  expect(created.status).toBe(201);
  const { data: workspace } = await created.json();
  await pool!.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')",
    [workspace.id, userIds[1]],
  );
  const before = await membershipSnapshot(workspace.id);
  const locker = await pool!.connect();
  let pending: Promise<Response> | undefined;
  try {
    await locker.query("BEGIN");
    const pid = await locker.query("SELECT pg_backend_pid() AS pid");
    await locker.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [workspace.id]);
    pending = changeRole(workspace.id, userIds[1], "editor", token);
    // Attach an immediate rejection handler while observing the database wait.
    void pending.catch(() => {});

    let blocked = false;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const waiting = await pool!.query(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
           WHERE datname = current_database()
             AND $1::int = ANY(pg_blocking_pids(pid))
             AND query ILIKE '%workspaces%'
         ) AS blocked`,
        [pid.rows[0].pid],
      );
      if (waiting.rows[0].blocked) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(blocked).toBe(true);
    expect(await membershipSnapshot(workspace.id)).toEqual(before);
    await locker.query("COMMIT");

    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { workspaceId: workspace.id, userId: userIds[1], role: "editor" },
    });
    expect(await membershipSnapshot(workspace.id)).toEqual([
      expect.objectContaining({ user_id: userIds[0], role: "owner" }),
      expect.objectContaining({ user_id: userIds[1], role: "editor" }),
    ]);
  } finally {
    // Release the lock even on assertion failure before fixture cleanup runs.
    try { await locker.query("ROLLBACK"); } finally { locker.release(); }
    if (pending) {
      await pending.then((response) => response.text()).catch(() => {});
    }
  }
});

test("the owner can remove a viewer and revoke access without deleting their account", async () => {
  const ownerToken = await login();
  const created = await create({ name: "Member removal team" }, ownerToken);
  expect(created.status).toBe(201);
  const { data: workspace } = await created.json();

  await pool!.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')",
    [workspace.id, userIds[1]],
  );
  const account = await pool!.query("SELECT email FROM users WHERE id = $1", [userIds[1]]);
  const viewerToken = await login(account.rows[0].email);
  const workspaceUrl = `${baseUrl}/workspaces/${workspace.id}`;
  const before = await fetch(workspaceUrl, {
    headers: { authorization: `Bearer ${viewerToken}` },
    signal: AbortSignal.timeout(5000),
  });
  expect(before.status).toBe(200);
  await before.json();

  const response = await fetch(`${workspaceUrl}/members/${userIds[1]}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${ownerToken}` },
    signal: AbortSignal.timeout(5000),
  });
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");

  const membership = await pool!.query(
    "SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
    [workspace.id, userIds[1]],
  );
  expect(membership.rows).toEqual([]);
  const savedAccount = await pool!.query("SELECT id FROM users WHERE id = $1", [userIds[1]]);
  expect(savedAccount.rows).toEqual([{ id: userIds[1] }]);
  expect(await membershipSnapshot(workspace.id)).toEqual([
    expect.objectContaining({ user_id: userIds[0], role: "owner" }),
  ]);

  // The previously issued token must no longer grant workspace access.
  const denied = await fetch(workspaceUrl, {
    headers: { authorization: `Bearer ${viewerToken}` },
    signal: AbortSignal.timeout(5000),
  });
  expect(denied.status).toBe(404);
  expect(await denied.json()).toEqual({
    error: {
      code: "NOT_FOUND",
      message: "Workspace not found",
      requestId: denied.headers.get("x-request-id"),
    },
  });
});

test.each(["editor", "viewer", "outsider"] as const)(
  "a workspace %s cannot remove members",
  async (role) => {
    const ownerToken = await login();
    const created = await create({ name: "Removal permissions team" }, ownerToken);
    expect(created.status).toBe(201);
    const { data: workspace } = await created.json();
    if (role !== "outsider") {
      await pool!.query(
        "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)",
        [workspace.id, userIds[1], role],
      );
    }
    const account = await pool!.query("SELECT email FROM users WHERE id = $1", [userIds[1]]);
    const token = await login(account.rows[0].email);
    const before = await membershipSnapshot(workspace.id);

    const response = await removeMember(workspace.id, userIds[0], token);

    expect(response.status).toBe(role === "outsider" ? 404 : 403);
    const body = await response.json();
    expect(body.error).toEqual({
      code: role === "outsider" ? "NOT_FOUND" : "FORBIDDEN",
      message: role === "outsider" ? "Workspace not found" : "Only owners can remove members",
      requestId: response.headers.get("x-request-id"),
    });
    expect(await membershipSnapshot(workspace.id)).toEqual(before);
  },
);

test("the owner cannot remove themselves", async () => {
  const token = await login();
  const created = await create({ name: "Owner removal protection" }, token);
  expect(created.status).toBe(201);
  const { data: workspace } = await created.json();
  const before = await membershipSnapshot(workspace.id);

  const response = await removeMember(workspace.id, userIds[0], token);

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: {
      code: "OWNERSHIP_TRANSFER_REQUIRED",
      message: "Transfer ownership before removing the owner",
      requestId: response.headers.get("x-request-id"),
    },
  });
  expect(await membershipSnapshot(workspace.id)).toEqual(before);
});

test("removing a user who is not a member returns 404", async () => {
  const token = await login();
  const created = await create({ name: "Missing removal member" }, token);
  expect(created.status).toBe(201);
  const { data: workspace } = await created.json();
  const before = await membershipSnapshot(workspace.id);

  const response = await removeMember(workspace.id, userIds[1], token);

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: {
      code: "NOT_FOUND",
      message: "Workspace member not found",
      requestId: response.headers.get("x-request-id"),
    },
  });
  expect(await membershipSnapshot(workspace.id)).toEqual(before);
});

test("removal rejects invalid workspace and member IDs", async () => {
  const token = await login();
  const created = await create({ name: "Removal ID validation" }, token);
  expect(created.status).toBe(201);
  const { data: workspace } = await created.json();
  await pool!.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')",
    [workspace.id, userIds[1]],
  );
  const before = await membershipSnapshot(workspace.id);

  for (const invalidId of ["abc", "0", "-1", "1.5", "2147483648"]) {
    for (const field of ["wid", "uid"]) {
      const response = await removeMember(
        field === "wid" ? invalidId : workspace.id,
        field === "uid" ? invalidId : userIds[1], token,
      );
      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ field }),
      ]));
    }
  }
  expect(await membershipSnapshot(workspace.id)).toEqual(before);
});

test("member removal waits for the workspace lock", async () => {
  const token = await login();
  const created = await create({ name: "Locked removal team" }, token);
  expect(created.status).toBe(201);
  const { data: workspace } = await created.json();
  await pool!.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')",
    [workspace.id, userIds[1]],
  );
  const before = await membershipSnapshot(workspace.id);
  const locker = await pool!.connect();
  let pending: Promise<Response> | undefined;
  try {
    await locker.query("BEGIN");
    const pid = await locker.query("SELECT pg_backend_pid() AS pid");
    await locker.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [workspace.id]);
    pending = removeMember(workspace.id, userIds[1], token);
    void pending.catch(() => {});

    let blocked = false;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const waiting = await pool!.query(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
           WHERE datname = current_database()
             AND $1::int = ANY(pg_blocking_pids(pid))
             AND query ILIKE '%workspaces%'
         ) AS blocked`,
        [pid.rows[0].pid],
      );
      if (waiting.rows[0].blocked) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(blocked).toBe(true);
    expect(await membershipSnapshot(workspace.id)).toEqual(before);
    await locker.query("COMMIT");

    const response = await pending;
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(await membershipSnapshot(workspace.id)).toEqual([
      expect.objectContaining({ user_id: userIds[0], role: "owner" }),
    ]);
  } finally {
    try { await locker.query("ROLLBACK"); } finally { locker.release(); }
    if (pending) await pending.then((response) => response.text()).catch(() => {});
  }
});

async function transferOwnership(workspaceId: number | string, body: unknown, token?: string) {
  return fetch(`${baseUrl}/workspaces/${workspaceId}/ownership-transfer`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

async function ownershipFixture(role: "editor" | "viewer" | "outsider" = "viewer") {
  const ownerToken = await login();
  const created = await create({ name: "Ownership transfer team" }, ownerToken);
  expect(created.status).toBe(201);
  const { data: workspace } = await created.json();
  if (role !== "outsider") {
    await pool!.query(
      "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)",
      [workspace.id, userIds[1], role],
    );
  }
  const account = await pool!.query("SELECT email FROM users WHERE id = $1", [userIds[1]]);
  const otherToken = await login(account.rows[0].email);
  return { workspaceId: workspace.id as number, ownerToken, otherToken };
}

test.each(["editor", "viewer"] as const)(
  "ownership can transfer to an existing %s, preserving creator attribution",
  async (role) => {
    const { workspaceId, ownerToken, otherToken } = await ownershipFixture(role);
    const response = await transferOwnership(workspaceId, {
      newOwnerId: userIds[1], actorId: userIds[1], role: "viewer",
    }, ownerToken);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        formerOwner: { workspaceId, userId: userIds[0], role: "editor" },
        newOwner: { workspaceId, userId: userIds[1], role: "owner" },
      },
    });
    expect(await membershipSnapshot(workspaceId)).toEqual([
      expect.objectContaining({ user_id: userIds[0], role: "editor" }),
      expect.objectContaining({ user_id: userIds[1], role: "owner" }),
    ]);
    const creator = await pool!.query("SELECT created_by FROM workspaces WHERE id = $1", [workspaceId]);
    expect(creator.rows).toEqual([{ created_by: userIds[0] }]);

    // Previously issued tokens must use current membership roles.
    const denied = await changeRole(workspaceId, userIds[1], "viewer", ownerToken);
    expect(denied.status).toBe(403);
    await denied.json();
    const allowed = await changeRole(workspaceId, userIds[0], "viewer", otherToken);
    expect(allowed.status).toBe(200);
    await allowed.json();
  },
);

test.each(["editor", "viewer", "outsider"] as const)(
  "a %s cannot transfer ownership",
  async (role) => {
    const { workspaceId, otherToken } = await ownershipFixture(role);
    const before = await membershipSnapshot(workspaceId);
    const response = await transferOwnership(workspaceId, { newOwnerId: userIds[0] }, otherToken);
    expect(response.status).toBe(role === "outsider" ? 404 : 403);
    const body = await response.json();
    expect(body.error.code).toBe(role === "outsider" ? "NOT_FOUND" : "FORBIDDEN");
    expect(await membershipSnapshot(workspaceId)).toEqual(before);
  },
);

test("ownership transfer requires authentication before body validation", async () => {
  const { workspaceId } = await ownershipFixture();
  const before = await membershipSnapshot(workspaceId);
  const response = await transferOwnership(workspaceId, {});
  expect(response.status).toBe(401);
  await response.text();
  expect(await membershipSnapshot(workspaceId)).toEqual(before);
});

test("the owner cannot transfer ownership to themselves", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const before = await membershipSnapshot(workspaceId);
  const response = await transferOwnership(workspaceId, { newOwnerId: userIds[0] }, ownerToken);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: {
      code: "ALREADY_OWNER", message: "You already own this workspace",
      requestId: response.headers.get("x-request-id"),
    },
  });
  expect(await membershipSnapshot(workspaceId)).toEqual(before);
});

test("a member of another workspace cannot be made owner without membership", async () => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture("outsider");
  const otherWorkspace = await create({ name: "Separate team" }, otherToken);
  expect(otherWorkspace.status).toBe(201);
  const { data: other } = await otherWorkspace.json();
  const before = await membershipSnapshot(workspaceId);
  const otherBefore = await membershipSnapshot(other.id);

  const response = await transferOwnership(workspaceId, { newOwnerId: userIds[1] }, ownerToken);
  expect(response.status).toBe(404);
  const body = await response.json();
  expect(body.error.message).toBe("Workspace member not found");
  expect(await membershipSnapshot(workspaceId)).toEqual(before);
  expect(await membershipSnapshot(other.id)).toEqual(otherBefore);
});

test("ownership transfer to a missing workspace returns 404", async () => {
  const token = await login();
  const missing = await pool!.query("SELECT id FROM workspaces WHERE id = 2147483647");
  expect(missing.rows).toEqual([]);
  const response = await transferOwnership(2147483647, { newOwnerId: userIds[1] }, token);
  expect(response.status).toBe(404);
  expect((await response.json()).error.code).toBe("NOT_FOUND");
});

test("ownership transfer rejects invalid IDs and missing or invalid target IDs", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const before = await membershipSnapshot(workspaceId);
  for (const invalid of ["abc", 0, -1, 1.5, 2147483648]) {
    const response = await transferOwnership(String(invalid), { newOwnerId: userIds[1] }, ownerToken);
    expect(response.status).toBe(422);
    expect((await response.json()).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "wid" }),
    ]));
  }
  for (const invalid of [undefined, null, "abc", 0, -1, 1.5, 2147483648, {}, []]) {
    const response = await transferOwnership(workspaceId, { newOwnerId: invalid }, ownerToken);
    expect(response.status).toBe(422);
    expect((await response.json()).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "newOwnerId" }),
    ]));
  }
  expect(await membershipSnapshot(workspaceId)).toEqual(before);
});

test("a failed promotion rolls back the former owner's demotion", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const before = await membershipSnapshot(workspaceId);
  const constraint = `transfer_failure_${randomUUID().replace(/-/g, "")}`;
  try {
    // Only prevent this fixture member from becoming owner, without invalidating other rows.
    await pool!.query(
      `ALTER TABLE workspace_members ADD CONSTRAINT ${constraint}
       CHECK (workspace_id <> ${workspaceId} OR user_id <> ${userIds[1]} OR role <> 'owner') NOT VALID`,
    );
    const response = await transferOwnership(workspaceId, { newOwnerId: userIds[1] }, ownerToken);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false, message: "Internal server error",
      requestId: response.headers.get("x-request-id"),
    });
    expect(await membershipSnapshot(workspaceId)).toEqual(before);
  } finally {
    await pool!.query(`ALTER TABLE workspace_members DROP CONSTRAINT IF EXISTS ${constraint}`);
  }
});

test("concurrent transfers produce one success and exactly one owner", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const responses = await Promise.all([
    transferOwnership(workspaceId, { newOwnerId: userIds[1] }, ownerToken),
    transferOwnership(workspaceId, { newOwnerId: userIds[1] }, ownerToken),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 403]);
  await Promise.all(responses.map((response) => response.json()));
  expect(await membershipSnapshot(workspaceId)).toEqual([
    expect.objectContaining({ user_id: userIds[0], role: "editor" }),
    expect.objectContaining({ user_id: userIds[1], role: "owner" }),
  ]);
});

test("a waiting transfer rechecks owner authority after the workspace lock is released", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const locker = await pool!.connect();
  let pending: Promise<Response> | undefined;
  try {
    await locker.query("BEGIN");
    const pid = await locker.query("SELECT pg_backend_pid() AS pid");
    await locker.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [workspaceId]);
    pending = transferOwnership(workspaceId, { newOwnerId: userIds[1] }, ownerToken);
    void pending.catch(() => {});
    let blocked = false;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const waiting = await pool!.query(
        `SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND $1::int = ANY(pg_blocking_pids(pid)) AND query ILIKE '%workspaces%'
        ) AS blocked`, [pid.rows[0].pid],
      );
      if (waiting.rows[0].blocked) { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(blocked).toBe(true);
    // Simulate a competing committed transfer while the request is waiting.
    await locker.query(
      "UPDATE workspace_members SET role = 'editor' WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userIds[0]],
    );
    await locker.query(
      "UPDATE workspace_members SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userIds[1]],
    );
    await locker.query("COMMIT");
    const response = await pending;
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("FORBIDDEN");
    expect(await membershipSnapshot(workspaceId)).toEqual([
      expect.objectContaining({ user_id: userIds[0], role: "editor" }),
      expect.objectContaining({ user_id: userIds[1], role: "owner" }),
    ]);
  } finally {
    try { await locker.query("ROLLBACK"); } finally { locker.release(); }
    if (pending) await pending.then((response) => response.text()).catch(() => {});
  }
});

async function invite(workspaceId: number | string, body: unknown, token?: string) {
  return fetch(`${baseUrl}/workspaces/${workspaceId}/invitations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

async function savedInvitations(workspaceId: number) {
  const result = await pool!.query(
    "SELECT * FROM invitations WHERE workspace_id = $1 ORDER BY id", [workspaceId],
  );
  return result.rows;
}

test.each(["editor", "viewer"])(
  "the owner can invite an %s with a hashed token and safe response",
  async (role) => {
    const { workspaceId, ownerToken } = await ownershipFixture();
    // Observe the insert from another connection to prove it committed before enqueue.
    queueEmail.mockImplementation(async (_name, payload) => {
      const job = payload as { invitationId: number };
      const committed = await pool!.query("SELECT id FROM invitations WHERE id = $1", [job.invitationId]);
      expect(committed.rows).toEqual([{ id: job.invitationId }]);
    });
    const start = Date.now();
    const response = await invite(workspaceId, {
      email: "  Sara@Example.com  ", role,
      invitedBy: userIds[1], workspaceId: -1,
      tokenHash: "caller-controlled", expiresAt: "2099-01-01",
    }, ownerToken);
    expect(response.status).toBe(201);
    const body = await response.json();
    const [saved] = await savedInvitations(workspaceId);
    expect(body).toEqual({ data: {
      id: saved.id, workspaceId, email: "sara@example.com", role,
      expiresAt: saved.expires_at.toISOString(), invitedBy: userIds[0],
      createdAt: saved.created_at.toISOString(),
    } });
    expect(saved.accepted_at).toBeNull();
    expect(saved.revoked_at).toBeNull();
    const lifetime = 7 * 24 * 60 * 60 * 1000;
    expect(saved.expires_at.getTime()).toBeGreaterThanOrEqual(start + lifetime);
    expect(saved.expires_at.getTime()).toBeLessThanOrEqual(Date.now() + lifetime);
    expect(queueEmail).toHaveBeenCalledTimes(1);
    const [name, payload, options] = queueEmail.mock.calls[0]!;
    const job = payload as { invitationId: number; email: string; token: string };
    expect(name).toBe("sendInvitationEmail");
    expect(job).toEqual({ invitationId: saved.id, email: "sara@example.com", token: expect.any(String) });
    expect(job.token).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.token_hash).toBe(createHash("sha256").update(job.token).digest("hex"));
    expect(saved.token_hash).not.toBe(job.token);
    expect(options).toEqual({
      jobId: `invitation-${saved.id}`, removeOnComplete: true,
      removeOnFail: { age: 86400 },
    });
    expect(JSON.stringify(body)).not.toContain(job.token);
    expect(JSON.stringify(body)).not.toContain(saved.token_hash);
    expect(JSON.stringify(requestLog.mock.calls)).not.toContain(job.token);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(job.token);
  },
);

test.each(["editor", "viewer", "outsider"] as const)(
  "an %s cannot issue invitations",
  async (role) => {
    const { workspaceId, otherToken } = await ownershipFixture(role);
    const response = await invite(workspaceId, { email: "sara@example.com", role: "editor" }, otherToken);
    expect(response.status).toBe(role === "outsider" ? 404 : 403);
    expect((await response.json()).error.code).toBe(role === "outsider" ? "NOT_FOUND" : "FORBIDDEN");
    expect(await savedInvitations(workspaceId)).toEqual([]);
    expect(queueEmail).not.toHaveBeenCalled();
  },
);

test("invitation creation requires authentication before validation", async () => {
  const { workspaceId } = await ownershipFixture();
  const response = await invite(workspaceId, {});
  expect(response.status).toBe(401);
  await response.text();
  expect(await savedInvitations(workspaceId)).toEqual([]);
  expect(queueEmail).not.toHaveBeenCalled();
});

test("invitation creation rejects invalid fields and workspace IDs", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  for (const invalidId of ["abc", "0", "-1", "1.5", "2147483648"]) {
    const response = await invite(invalidId, { email: "sara@example.com", role: "editor" }, ownerToken);
    expect(response.status).toBe(422);
    expect((await response.json()).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "wid" }),
    ]));
  }
  for (const email of [undefined, null, "", "not-an-email", 42, `${"a".repeat(250)}@example.com`]) {
    const response = await invite(workspaceId, { email, role: "editor" }, ownerToken);
    expect(response.status).toBe(422);
    expect((await response.json()).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "email" }),
    ]));
  }
  for (const role of [undefined, null, "", "owner", "admin", 42]) {
    const response = await invite(workspaceId, { email: "sara@example.com", role }, ownerToken);
    expect(response.status).toBe(422);
    expect((await response.json()).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "role" }),
    ]));
  }
  expect(await savedInvitations(workspaceId)).toEqual([]);
  expect(queueEmail).not.toHaveBeenCalled();
});

test("a missing invitation workspace returns 404 without queueing", async () => {
  const token = await login();
  expect((await pool!.query("SELECT id FROM workspaces WHERE id = 2147483647")).rows).toEqual([]);
  const response = await invite(2147483647, { email: "sara@example.com", role: "viewer" }, token);
  expect(response.status).toBe(404);
  expect((await response.json()).error.code).toBe("NOT_FOUND");
  expect(queueEmail).not.toHaveBeenCalled();
});

test("queue failure reports 503 and preserves the committed invitation", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  queueEmail.mockRejectedValueOnce(new Error("Queue unavailable"));
  const response = await invite(workspaceId, { email: "sara@example.com", role: "viewer" }, ownerToken);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: {
    code: "INVITATION_EMAIL_QUEUE_FAILED",
    message: "Invitation was saved, but its email could not be queued",
    requestId: response.headers.get("x-request-id"),
  } });
  const rows = await savedInvitations(workspaceId);
  expect(rows).toHaveLength(1);
  expect(rows[0].token_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(queueEmail).toHaveBeenCalledTimes(1);
});

test("a failed invitation insert cannot enqueue an email", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const constraint = `invitation_failure_${randomUUID().replace(/-/g, "")}`;
  try {
    await pool!.query(
      `ALTER TABLE invitations ADD CONSTRAINT ${constraint} CHECK (workspace_id <> ${workspaceId}) NOT VALID`,
    );
    const response = await invite(workspaceId, { email: "sara@example.com", role: "viewer" }, ownerToken);
    expect(response.status).toBe(500);
    await response.json();
    expect(await savedInvitations(workspaceId)).toEqual([]);
    expect(queueEmail).not.toHaveBeenCalled();
  } finally {
    await pool!.query(`ALTER TABLE invitations DROP CONSTRAINT IF EXISTS ${constraint}`);
  }
});

test("invitation token hashes are unique and invalid roles are rejected by PostgreSQL", async () => {
  const { workspaceId } = await ownershipFixture();
  const tokenHash = createHash("sha256").update(randomUUID()).digest("hex");
  const sql = `INSERT INTO invitations (workspace_id, email, role, token_hash, expires_at, invited_by)
    VALUES ($1, 'sara@example.com', $2, $3, now() + interval '7 days', $4)`;
  await pool!.query(sql, [workspaceId, "viewer", tokenHash, userIds[0]]);
  await expect(pool!.query(sql, [workspaceId, "editor", tokenHash, userIds[0]]))
    .rejects.toMatchObject({ code: "23505" });
  await expect(pool!.query(sql, [workspaceId, "owner", "b".repeat(64), userIds[0]]))
    .rejects.toMatchObject({ code: "23514" });
  expect(await savedInvitations(workspaceId)).toHaveLength(1);
});

test("workspace deletion cascades to its invitations", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const response = await invite(workspaceId, { email: "sara@example.com", role: "viewer" }, ownerToken);
  expect(response.status).toBe(201);
  await response.json();
  await pool!.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
  expect(await savedInvitations(workspaceId)).toEqual([]);
});

test("sender deletion cascades to invitations they issued", async () => {
  const { workspaceId } = await ownershipFixture("outsider");
  // A sender may have already left after issuing an invitation.
  await pool!.query(
    `INSERT INTO invitations (workspace_id, email, role, token_hash, expires_at, invited_by)
     VALUES ($1, 'sara@example.com', 'viewer', $2, now() + interval '7 days', $3)`,
    [workspaceId, createHash("sha256").update(randomUUID()).digest("hex"), userIds[1]],
  );
  await pool!.query("DELETE FROM users WHERE id = $1", [userIds[1]]);
  expect(await savedInvitations(workspaceId)).toEqual([]);
  expect((await pool!.query("SELECT id FROM workspaces WHERE id = $1", [workspaceId])).rows)
    .toEqual([{ id: workspaceId }]);
});

async function acceptanceFixture() {
  const fixture = await ownershipFixture("outsider");
  const account = await pool!.query("SELECT email FROM users WHERE id = $1", [userIds[1]]);
  return { ...fixture, email: account.rows[0].email as string };
}

async function issueInvitation(workspaceId: number, email: string, ownerToken: string, role = "viewer") {
  const response = await invite(workspaceId, { email, role }, ownerToken);
  expect(response.status).toBe(201);
  const { data } = await response.json();
  const call = queueEmail.mock.calls[queueEmail.mock.calls.length - 1]!;
  const payload = call[1] as { token: string; invitationId: number };
  expect(payload.invitationId).toBe(data.id);
  return { id: data.id as number, token: payload.token };
}

async function acceptInvite(token: unknown, authToken?: string, extra: object = {}) {
  return fetch(`${baseUrl}/invitations/accept`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify({ token, ...extra }),
    signal: AbortSignal.timeout(5000),
  });
}

test.each(["editor", "viewer"])("an invited recipient can join as %s and reuse is rejected", async (role) => {
  const { workspaceId, ownerToken, otherToken, email } = await acceptanceFixture();
  const invitation = await issueInvitation(workspaceId, email, ownerToken, role);
  const response = await acceptInvite(invitation.token, otherToken, {
    userId: userIds[0], email: ownerEmail, role: "owner", workspaceId: -1,
  });
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({
    data: { workspaceId, userId: userIds[1], role },
  });
  const [saved] = await savedInvitations(workspaceId);
  expect(saved.accepted_at).toBeInstanceOf(Date);
  expect(saved.revoked_at).toBeNull();
  expect(await membershipSnapshot(workspaceId)).toEqual([
    expect.objectContaining({ user_id: userIds[0], role: "owner" }),
    expect.objectContaining({ user_id: userIds[1], role }),
  ]);
  const repeated = await acceptInvite(invitation.token, otherToken);
  expect(repeated.status).toBe(409);
  expect((await repeated.json()).error.code).toBe("INVITATION_UNAVAILABLE");
});

test("acceptance requires authentication and a valid token format", async () => {
  const response = await acceptInvite(undefined);
  expect(response.status).toBe(401);
  await response.text();
  const token = await login();
  for (const malformed of [undefined, null, 42, "", "a".repeat(63), "a".repeat(65), "g".repeat(64)]) {
    const invalid = await acceptInvite(malformed, token);
    expect(invalid.status).toBe(422);
    expect((await invalid.json()).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "token" }),
    ]));
  }
  const unknown = await acceptInvite("0".repeat(64), token);
  expect(unknown.status).toBe(404);
  expect((await unknown.json()).error.code).toBe("NOT_FOUND");
});

test("the wrong account cannot accept or close someone else's invitation", async () => {
  const { workspaceId, ownerToken, email } = await acceptanceFixture();
  const invitation = await issueInvitation(workspaceId, email, ownerToken);
  const before = await savedInvitations(workspaceId);
  const memberships = await membershipSnapshot(workspaceId);
  // The owner is already a member, but email matching must precede closure.
  const response = await acceptInvite(invitation.token, ownerToken, { email });
  expect(response.status).toBe(403);
  expect((await response.json()).error.code).toBe("INVITATION_EMAIL_MISMATCH");
  expect(await savedInvitations(workspaceId)).toEqual(before);
  expect(await membershipSnapshot(workspaceId)).toEqual(memberships);
});

test("acceptance compares the current database email, not request identity fields", async () => {
  const { workspaceId, ownerToken, otherToken, email } = await acceptanceFixture();
  const invitation = await issueInvitation(workspaceId, email, ownerToken);
  await pool!.query("UPDATE users SET email = $1 WHERE id = $2", ["changed@test.local", userIds[1]]);
  const response = await acceptInvite(invitation.token, otherToken, { email });
  expect(response.status).toBe(403);
  await response.json();
  expect((await savedInvitations(workspaceId))[0].accepted_at).toBeNull();
});

test.each(["expired", "revoked", "accepted"])("a %s invitation cannot create membership", async (state) => {
  const { workspaceId, ownerToken, otherToken, email } = await acceptanceFixture();
  const invitation = await issueInvitation(workspaceId, email, ownerToken);
  const statements: Record<string, string> = {
    expired: "UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = $1",
    revoked: "UPDATE invitations SET revoked_at = now() WHERE id = $1",
    accepted: "UPDATE invitations SET accepted_at = now() WHERE id = $1",
  };
  await pool!.query(statements[state], [invitation.id]);
  const before = await savedInvitations(workspaceId);
  const memberships = await membershipSnapshot(workspaceId);
  const response = await acceptInvite(invitation.token, otherToken);
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("INVITATION_UNAVAILABLE");
  expect(await savedInvitations(workspaceId)).toEqual(before);
  expect(await membershipSnapshot(workspaceId)).toEqual(memberships);
});

test("acceptance revokes other pending invitations only for that recipient and workspace", async () => {
  const { workspaceId, ownerToken, otherToken, email } = await acceptanceFixture();
  const chosen = await issueInvitation(workspaceId, email, ownerToken);
  const alternative = await issueInvitation(workspaceId, email, ownerToken, "editor");
  const unrelated = await issueInvitation(workspaceId, "someone@example.com", ownerToken);
  const otherWorkspace = await create({ name: "Another invitation team" }, ownerToken);
  expect(otherWorkspace.status).toBe(201);
  const { data: other } = await otherWorkspace.json();
  await issueInvitation(other.id, email, ownerToken);
  const otherBefore = await savedInvitations(other.id);

  const response = await acceptInvite(chosen.token, otherToken);
  expect(response.status).toBe(201);
  await response.json();
  const rows = await savedInvitations(workspaceId);
  expect(rows.find((row) => row.id === chosen.id).accepted_at).toBeInstanceOf(Date);
  expect(rows.find((row) => row.id === alternative.id).revoked_at).toBeInstanceOf(Date);
  expect(rows.find((row) => row.id === unrelated.id).revoked_at).toBeNull();
  expect(await savedInvitations(other.id)).toEqual(otherBefore);
  // Even after removal, the second invitation cannot be used to rejoin.
  const removed = await removeMember(workspaceId, userIds[1], ownerToken);
  expect(removed.status).toBe(204);
  const denied = await acceptInvite(alternative.token, otherToken);
  expect(denied.status).toBe(409);
  await denied.json();
});

test("an existing member keeps their role and closes pending invitations despite the 409", async () => {
  const { workspaceId, ownerToken, otherToken, email } = await acceptanceFixture();
  const first = await issueInvitation(workspaceId, email, ownerToken, "viewer");
  await issueInvitation(workspaceId, email, ownerToken, "editor");
  await pool!.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'editor')",
    [workspaceId, userIds[1]],
  );
  const before = await membershipSnapshot(workspaceId);
  const response = await acceptInvite(first.token, otherToken);
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("ALREADY_MEMBER");
  expect(await membershipSnapshot(workspaceId)).toEqual(before);
  for (const saved of await savedInvitations(workspaceId)) {
    expect(saved.accepted_at).toBeNull();
    expect(saved.revoked_at).toBeInstanceOf(Date);
  }
});

test.each(["accepted", "revoked"])("failure writing %s state rolls back the entire acceptance", async (stage) => {
  const { workspaceId, ownerToken, otherToken, email } = await acceptanceFixture();
  const chosen = await issueInvitation(workspaceId, email, ownerToken);
  const alternative = await issueInvitation(workspaceId, email, ownerToken);
  const before = await savedInvitations(workspaceId);
  const memberships = await membershipSnapshot(workspaceId);
  const constraint = `accept_failure_${randomUUID().replace(/-/g, "")}`;
  const id = stage === "accepted" ? chosen.id : alternative.id;
  const column = stage === "accepted" ? "accepted_at" : "revoked_at";
  try {
    await pool!.query(
      `ALTER TABLE invitations ADD CONSTRAINT ${constraint} CHECK (id <> ${id} OR ${column} IS NULL) NOT VALID`,
    );
    const response = await acceptInvite(chosen.token, otherToken);
    expect(response.status).toBe(500);
    await response.json();
    expect(await savedInvitations(workspaceId)).toEqual(before);
    expect(await membershipSnapshot(workspaceId)).toEqual(memberships);
  } finally {
    await pool!.query(`ALTER TABLE invitations DROP CONSTRAINT IF EXISTS ${constraint}`);
  }
});

test.each(["same", "different"])("concurrent acceptance of %s tokens creates only one membership", async (which) => {
  const { workspaceId, ownerToken, otherToken, email } = await acceptanceFixture();
  const first = await issueInvitation(workspaceId, email, ownerToken);
  const second = which === "same" ? first : await issueInvitation(workspaceId, email, ownerToken);
  const responses = await Promise.all([
    acceptInvite(first.token, otherToken), acceptInvite(second.token, otherToken),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
  await Promise.all(responses.map((response) => response.json()));
  expect(await membershipSnapshot(workspaceId)).toEqual([
    expect.objectContaining({ user_id: userIds[0], role: "owner" }),
    expect.objectContaining({ user_id: userIds[1], role: "viewer" }),
  ]);
  const saved = await savedInvitations(workspaceId);
  expect(saved.filter((row) => row.accepted_at !== null)).toHaveLength(1);
  expect(saved.every((row) => row.accepted_at || row.revoked_at)).toBe(true);
});

test("acceptance rereads revocation after waiting for the workspace lock", async () => {
  const { workspaceId, ownerToken, otherToken, email } = await acceptanceFixture();
  const invitation = await issueInvitation(workspaceId, email, ownerToken);
  const locker = await pool!.connect();
  let pending: Promise<Response> | undefined;
  try {
    await locker.query("BEGIN");
    const pid = await locker.query("SELECT pg_backend_pid() AS pid");
    await locker.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [workspaceId]);
    pending = acceptInvite(invitation.token, otherToken);
    void pending.catch(() => {});
    let blocked = false;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const waiting = await pool!.query(
        `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))) AS blocked`,
        [pid.rows[0].pid],
      );
      if (waiting.rows[0].blocked) { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(blocked).toBe(true);
    await locker.query("UPDATE invitations SET revoked_at = now() WHERE id = $1", [invitation.id]);
    await locker.query("COMMIT");
    const response = await pending;
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("INVITATION_UNAVAILABLE");
    expect(await membershipSnapshot(workspaceId)).toHaveLength(1);
  } finally {
    try { await locker.query("ROLLBACK"); } finally { locker.release(); }
    if (pending) await pending.then((response) => response.text()).catch(() => {});
  }
});

test("member removal revokes pending invitations and prevents rejoining", async () => {
  const { workspaceId, ownerToken, otherToken, email } = await acceptanceFixture();
  const first = await issueInvitation(workspaceId, email, ownerToken);
  await issueInvitation(workspaceId, email, ownerToken);
  const unrelated = await issueInvitation(workspaceId, "unrelated@example.com", ownerToken);
  await pool!.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')",
    [workspaceId, userIds[1]],
  );

  const response = await removeMember(workspaceId, userIds[1], ownerToken);
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
  expect(await membershipSnapshot(workspaceId)).toHaveLength(1);
  const invitations = await savedInvitations(workspaceId);
  for (const row of invitations.filter((row) => row.email === email)) {
    expect(row.revoked_at).toBeInstanceOf(Date);
    expect(row.accepted_at).toBeNull();
  }
  expect(invitations.find((row) => row.id === unrelated.id).revoked_at).toBeNull();
  const denied = await acceptInvite(first.token, otherToken);
  expect(denied.status).toBe(409);
  expect((await denied.json()).error.code).toBe("INVITATION_UNAVAILABLE");
});

test("failed invitation revocation rolls back member removal and earlier revocations", async () => {
  const { workspaceId, ownerToken, email } = await acceptanceFixture();
  await issueInvitation(workspaceId, email, ownerToken);
  const second = await issueInvitation(workspaceId, email, ownerToken);
  await pool!.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')",
    [workspaceId, userIds[1]],
  );
  const memberships = await membershipSnapshot(workspaceId);
  const invitations = await savedInvitations(workspaceId);
  const constraint = `removal_revoke_failure_${randomUUID().replace(/-/g, "")}`;
  try {
    await pool!.query(
      `ALTER TABLE invitations ADD CONSTRAINT ${constraint} CHECK (id <> ${second.id} OR revoked_at IS NULL) NOT VALID`,
    );
    const response = await removeMember(workspaceId, userIds[1], ownerToken);
    expect(response.status).toBe(500);
    await response.json();
    expect(await membershipSnapshot(workspaceId)).toEqual(memberships);
    expect(await savedInvitations(workspaceId)).toEqual(invitations);
  } finally {
    await pool!.query(`ALTER TABLE invitations DROP CONSTRAINT IF EXISTS ${constraint}`);
  }
});

test.each(["owner", "editor", "viewer"] as const)(
  "inviting an existing %s is rejected regardless of email casing or spaces",
  async (role) => {
    const { workspaceId, ownerToken } = await ownershipFixture(role === "owner" ? "outsider" : role);
    const memberId = role === "owner" ? userIds[0] : userIds[1];
    const account = await pool!.query("SELECT email FROM users WHERE id = $1", [memberId]);
    const email = account.rows[0].email as string;
    // Legacy account emails may themselves contain casing or whitespace.
    await pool!.query("UPDATE users SET email = $1 WHERE id = $2", [` ${email.toUpperCase()} `, memberId]);
    const before = await membershipSnapshot(workspaceId);

    for (const requestedEmail of [email, email.toUpperCase(), `  ${email.toUpperCase()}  `]) {
      const response = await invite(workspaceId, { email: requestedEmail, role: "viewer" }, ownerToken);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: {
        code: "ALREADY_MEMBER",
        message: "This user already belongs to the workspace",
        requestId: response.headers.get("x-request-id"),
      } });
    }

    expect(await savedInvitations(workspaceId)).toEqual([]);
    expect(queueEmail).not.toHaveBeenCalled();
    expect(await membershipSnapshot(workspaceId)).toEqual(before);
  },
);

test("membership in another workspace does not prevent an invitation here", async () => {
  const { workspaceId, ownerToken, otherToken, email } = await acceptanceFixture();
  const otherWorkspace = await create({ name: "Recipient's own team" }, otherToken);
  expect(otherWorkspace.status).toBe(201);
  const { data: other } = await otherWorkspace.json();
  const otherBefore = await membershipSnapshot(other.id);

  const response = await invite(workspaceId, { email, role: "editor" }, ownerToken);

  expect(response.status).toBe(201);
  expect((await response.json()).data).toMatchObject({ workspaceId, email, role: "editor" });
  expect(await savedInvitations(workspaceId)).toHaveLength(1);
  expect(queueEmail).toHaveBeenCalledTimes(1);
  expect(await membershipSnapshot(other.id)).toEqual(otherBefore);
});

async function listInvitations(workspaceId: number | string, token?: string, cursor?: string) {
  const url = new URL(`${baseUrl}/workspaces/${workspaceId}/invitations`);
  if (cursor !== undefined) url.searchParams.set("afterId", cursor);
  return fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5000),
  });
}

test("an owner gets an empty invitation page for a workspace without invitations", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const response = await listInvitations(workspaceId, ownerToken);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: [], page: { nextCursor: null } });
});

test("invitation listing includes history, excludes other workspaces, and exposes no credentials", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const issued = [];
  for (const state of ["pending", "accepted", "revoked", "expired"]) {
    const invitation = await issueInvitation(workspaceId, `${state}@example.com`, ownerToken);
    issued.push(invitation);
    if (state === "accepted") {
      await pool!.query("UPDATE invitations SET accepted_at = now() WHERE id = $1", [invitation.id]);
    } else if (state === "revoked") {
      await pool!.query("UPDATE invitations SET revoked_at = now() WHERE id = $1", [invitation.id]);
    } else if (state === "expired") {
      await pool!.query("UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = $1", [invitation.id]);
    }
  }
  const otherCreated = await create({ name: "Another invitation workspace" }, ownerToken);
  expect(otherCreated.status).toBe(201);
  const { data: otherWorkspace } = await otherCreated.json();
  await issueInvitation(otherWorkspace.id, "hidden@example.com", ownerToken);
  const before = await savedInvitations(workspaceId);

  const response = await listInvitations(workspaceId, ownerToken);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({
    data: before.map((row) => ({
      id: row.id, email: row.email, role: row.role, invitedBy: row.invited_by,
      expiresAt: row.expires_at.toISOString(),
      acceptedAt: row.accepted_at?.toISOString() ?? null,
      revokedAt: row.revoked_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
    })),
    page: { nextCursor: null },
  });
  for (const invitation of issued) {
    expect(JSON.stringify(body)).not.toContain(invitation.token);
  }
  for (const row of before) expect(JSON.stringify(body)).not.toContain(row.token_hash);
  expect(await savedInvitations(workspaceId)).toEqual(before);
});

test.each([20, 21])("invitation pagination handles %i records with accurate cursors", async (count) => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const prefix = randomUUID().replace(/-/g, "");
  const inserted = await pool!.query(
    `INSERT INTO invitations (workspace_id, email, role, token_hash, expires_at, invited_by)
     SELECT $1, 'page' || n::text || '@example.com', 'viewer',
       $3::text || lpad(n::text, 32, '0'), now() + interval '7 days', $2
     FROM generate_series(1, $4::int) AS n RETURNING id`,
    [workspaceId, userIds[0], prefix, count],
  );
  const ids: number[] = inserted.rows.map((row) => row.id).sort((a, b) => a - b);
  const firstResponse = await listInvitations(workspaceId, ownerToken, "0");
  expect(firstResponse.status).toBe(200);
  const first = await firstResponse.json();
  expect(first.data.map((row: { id: number }) => row.id)).toEqual(ids.slice(0, 20));
  expect(first.page.nextCursor).toBe(count === 21 ? ids[19] : null);

  if (count === 21) {
    const secondResponse = await listInvitations(workspaceId, ownerToken, String(first.page.nextCursor));
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json();
    expect(second.data.map((row: { id: number }) => row.id)).toEqual(ids.slice(20));
    expect(second.page.nextCursor).toBeNull();
  }
  const beyondResponse = await listInvitations(workspaceId, ownerToken, "2147483647");
  expect(beyondResponse.status).toBe(200);
  expect(await beyondResponse.json()).toEqual({ data: [], page: { nextCursor: null } });
});

test.each(["editor", "viewer", "outsider"] as const)(
  "an %s cannot list workspace invitations",
  async (role) => {
    const { workspaceId, ownerToken, otherToken } = await ownershipFixture(role);
    await issueInvitation(workspaceId, "private@example.com", ownerToken);
    const before = await savedInvitations(workspaceId);
    const response = await listInvitations(workspaceId, otherToken);
    expect(response.status).toBe(role === "outsider" ? 404 : 403);
    const body = await response.json();
    expect(body.error.code).toBe(role === "outsider" ? "NOT_FOUND" : "FORBIDDEN");
    expect(body.data).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("private@example.com");
    expect(await savedInvitations(workspaceId)).toEqual(before);
  },
);

test("invitation listing requires authentication before validating the workspace ID", async () => {
  const response = await listInvitations("invalid");
  expect(response.status).toBe(401);
  await response.text();
});

test("listing invitations for a missing workspace returns 404", async () => {
  const token = await login();
  expect((await pool!.query("SELECT id FROM workspaces WHERE id = 2147483647")).rows).toEqual([]);
  const response = await listInvitations(2147483647, token);
  expect(response.status).toBe(404);
  expect((await response.json()).error.code).toBe("NOT_FOUND");
});

test("invitation listing rejects invalid workspace IDs and cursors", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  for (const id of ["abc", "0", "-1", "1.5", "2147483648"]) {
    const response = await listInvitations(id, ownerToken);
    expect(response.status).toBe(422);
    expect((await response.json()).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "wid" }),
    ]));
  }
  for (const cursor of ["abc", "-1", "1.5", "2147483648"]) {
    const response = await listInvitations(workspaceId, ownerToken, cursor);
    expect(response.status).toBe(422);
    expect((await response.json()).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "afterId" }),
    ]));
  }
});

test("invitation list access follows current ownership, even with previously issued tokens", async () => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture();
  const invitation = await issueInvitation(workspaceId, "private@example.com", ownerToken);
  const transfer = await transferOwnership(workspaceId, { newOwnerId: userIds[1] }, ownerToken);
  expect(transfer.status).toBe(200);
  await transfer.json();

  const former = await listInvitations(workspaceId, ownerToken);
  expect(former.status).toBe(403);
  await former.json();
  const current = await listInvitations(workspaceId, otherToken);
  expect(current.status).toBe(200);
  expect((await current.json()).data).toEqual([
    expect.objectContaining({ id: invitation.id, email: "private@example.com" }),
  ]);
});

async function revokeInvitation(workspaceId: number | string, invitationId: number | string, token?: string) {
  return fetch(`${baseUrl}/workspaces/${workspaceId}/invitations/${invitationId}`, {
    method: "DELETE",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5000),
  });
}

test("the owner can revoke an invitation, preserve history, and block acceptance", async () => {
  const { workspaceId, ownerToken, otherToken, email } = await acceptanceFixture();
  const invitation = await issueInvitation(workspaceId, email, ownerToken);
  const beforeMemberships = await membershipSnapshot(workspaceId);
  const response = await revokeInvitation(workspaceId, invitation.id, ownerToken);
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
  const [saved] = await savedInvitations(workspaceId);
  expect(saved.id).toBe(invitation.id);
  expect(saved.revoked_at).toBeInstanceOf(Date);
  expect(saved.updated_at).toEqual(saved.revoked_at);
  expect(saved.accepted_at).toBeNull();
  expect(await membershipSnapshot(workspaceId)).toEqual(beforeMemberships);
  const denied = await acceptInvite(invitation.token, otherToken);
  expect(denied.status).toBe(409);
  expect((await denied.json()).error.code).toBe("INVITATION_UNAVAILABLE");

  const repeated = await revokeInvitation(workspaceId, invitation.id, ownerToken);
  expect(repeated.status).toBe(204);
  expect(await repeated.text()).toBe("");
  expect(await savedInvitations(workspaceId)).toEqual([saved]);
  expect(queueEmail).toHaveBeenCalledTimes(1);
});

test.each(["editor", "viewer", "outsider"] as const)(
  "an %s cannot revoke invitations",
  async (role) => {
    const { workspaceId, ownerToken, otherToken } = await ownershipFixture(role);
    const invitation = await issueInvitation(workspaceId, "private@example.com", ownerToken);
    const before = await savedInvitations(workspaceId);
    const response = await revokeInvitation(workspaceId, invitation.id, otherToken);
    expect(response.status).toBe(role === "outsider" ? 404 : 403);
    expect((await response.json()).error.code).toBe(role === "outsider" ? "NOT_FOUND" : "FORBIDDEN");
    expect(await savedInvitations(workspaceId)).toEqual(before);
  },
);

test("revocation requires authentication before ID validation", async () => {
  const response = await revokeInvitation("invalid", "invalid");
  expect(response.status).toBe(401);
  await response.text();
});

test("accepted invitations cannot be revoked and their memberships remain intact", async () => {
  const { workspaceId, ownerToken, otherToken, email } = await acceptanceFixture();
  const invitation = await issueInvitation(workspaceId, email, ownerToken);
  const accepted = await acceptInvite(invitation.token, otherToken);
  expect(accepted.status).toBe(201);
  await accepted.json();
  const invitations = await savedInvitations(workspaceId);
  const memberships = await membershipSnapshot(workspaceId);
  const response = await revokeInvitation(workspaceId, invitation.id, ownerToken);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: {
    code: "INVITATION_ALREADY_ACCEPTED",
    message: "Use member removal to revoke workspace access",
    requestId: response.headers.get("x-request-id"),
  } });
  expect(await savedInvitations(workspaceId)).toEqual(invitations);
  expect(await membershipSnapshot(workspaceId)).toEqual(memberships);
});

test("expired but unused invitations can still be explicitly revoked", async () => {
  const { workspaceId, ownerToken, email } = await acceptanceFixture();
  const invitation = await issueInvitation(workspaceId, email, ownerToken);
  await pool!.query("UPDATE invitations SET expires_at = now() - interval '1 day' WHERE id = $1", [invitation.id]);
  const response = await revokeInvitation(workspaceId, invitation.id, ownerToken);
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
  expect((await savedInvitations(workspaceId))[0].revoked_at).toBeInstanceOf(Date);
});

test("an invitation ID cannot be used under a different workspace, even with ownership of both", async () => {
  const { workspaceId, ownerToken, email } = await acceptanceFixture();
  const invitation = await issueInvitation(workspaceId, email, ownerToken);
  const created = await create({ name: "Other revocation team" }, ownerToken);
  expect(created.status).toBe(201);
  const { data: other } = await created.json();
  const before = await savedInvitations(workspaceId);
  const response = await revokeInvitation(other.id, invitation.id, ownerToken);
  expect(response.status).toBe(404);
  expect((await response.json()).error.message).toBe("Invitation not found");
  expect(await savedInvitations(workspaceId)).toEqual(before);
});

test("missing workspaces and missing invitations return 404", async () => {
  const { workspaceId, ownerToken, email } = await acceptanceFixture();
  const invitation = await issueInvitation(workspaceId, email, ownerToken);
  expect((await pool!.query("SELECT id FROM workspaces WHERE id = 2147483647")).rows).toEqual([]);
  expect((await pool!.query("SELECT id FROM invitations WHERE id = 2147483647")).rows).toEqual([]);
  const before = await savedInvitations(workspaceId);
  for (const [wid, iid] of [[2147483647, invitation.id], [workspaceId, 2147483647]]) {
    const response = await revokeInvitation(wid, iid, ownerToken);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  }
  expect(await savedInvitations(workspaceId)).toEqual(before);
});

test("revocation rejects malformed workspace and invitation IDs without mutations", async () => {
  const { workspaceId, ownerToken, email } = await acceptanceFixture();
  const invitation = await issueInvitation(workspaceId, email, ownerToken);
  const before = await savedInvitations(workspaceId);
  for (const invalid of ["abc", "0", "-1", "1.5", "2147483648"]) {
    for (const field of ["wid", "iid"]) {
      const response = await revokeInvitation(
        field === "wid" ? invalid : workspaceId,
        field === "iid" ? invalid : invitation.id, ownerToken,
      );
      expect(response.status).toBe(422);
      expect((await response.json()).errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ field }),
      ]));
    }
  }
  expect(await savedInvitations(workspaceId)).toEqual(before);
});

test("only the current owner can revoke after an ownership transfer", async () => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture();
  const invitation = await issueInvitation(workspaceId, "recipient@example.com", ownerToken);
  const transfer = await transferOwnership(workspaceId, { newOwnerId: userIds[1] }, ownerToken);
  expect(transfer.status).toBe(200);
  await transfer.json();
  const before = await savedInvitations(workspaceId);
  const former = await revokeInvitation(workspaceId, invitation.id, ownerToken);
  expect(former.status).toBe(403);
  await former.json();
  expect(await savedInvitations(workspaceId)).toEqual(before);
  const current = await revokeInvitation(workspaceId, invitation.id, otherToken);
  expect(current.status).toBe(204);
  await current.text();
  expect((await savedInvitations(workspaceId))[0].revoked_at).toBeInstanceOf(Date);
});

test("a failed revocation write leaves the invitation usable and unchanged", async () => {
  const { workspaceId, ownerToken, otherToken, email } = await acceptanceFixture();
  const invitation = await issueInvitation(workspaceId, email, ownerToken);
  const before = await savedInvitations(workspaceId);
  const constraint = `revoke_failure_${randomUUID().replace(/-/g, "")}`;
  try {
    await pool!.query(
      `ALTER TABLE invitations ADD CONSTRAINT ${constraint} CHECK (id <> ${invitation.id} OR revoked_at IS NULL) NOT VALID`,
    );
    const response = await revokeInvitation(workspaceId, invitation.id, ownerToken);
    expect(response.status).toBe(500);
    await response.json();
    expect(await savedInvitations(workspaceId)).toEqual(before);
  } finally {
    await pool!.query(`ALTER TABLE invitations DROP CONSTRAINT IF EXISTS ${constraint}`);
  }
  const accepted = await acceptInvite(invitation.token, otherToken);
  expect(accepted.status).toBe(201);
  await accepted.json();
});

test("concurrent revocations both succeed with one revoked invitation", async () => {
  const { workspaceId, ownerToken, email } = await acceptanceFixture();
  const invitation = await issueInvitation(workspaceId, email, ownerToken);
  const responses = await Promise.all([
    revokeInvitation(workspaceId, invitation.id, ownerToken),
    revokeInvitation(workspaceId, invitation.id, ownerToken),
  ]);
  expect(responses.map((response) => response.status)).toEqual([204, 204]);
  await Promise.all(responses.map((response) => response.text()));
  expect(await savedInvitations(workspaceId)).toEqual([
    expect.objectContaining({ id: invitation.id, revoked_at: expect.any(Date), accepted_at: null }),
  ]);
});

test.each(["acceptance", "revocation"])(
  "%s winning the lock determines the result of the competing operation",
  async (winner) => {
    const { workspaceId, ownerToken, otherToken, email } = await acceptanceFixture();
    const invitation = await issueInvitation(workspaceId, email, ownerToken);
    const locker = await pool!.connect();
    let first: Promise<Response> | undefined;
    let second: Promise<Response> | undefined;
    try {
      await locker.query("BEGIN");
      const pid = await locker.query("SELECT pg_backend_pid() AS pid");
      // Hold only the invitation row: the first API request can acquire the workspace lock.
      await locker.query("SELECT id FROM invitations WHERE id = $1 FOR UPDATE", [invitation.id]);
      first = winner === "acceptance"
        ? acceptInvite(invitation.token, otherToken)
        : revokeInvitation(workspaceId, invitation.id, ownerToken);
      void first.catch(() => {});
      let blocked = false;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const waiting = await pool!.query(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
           WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))) AS blocked`,
          [pid.rows[0].pid],
        );
        if (waiting.rows[0].blocked) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(blocked).toBe(true);
      second = winner === "acceptance"
        ? revokeInvitation(workspaceId, invitation.id, ownerToken)
        : acceptInvite(invitation.token, otherToken);
      void second.catch(() => {});
      await locker.query("COMMIT");
      const [won, lost] = await Promise.all([first, second]);
      expect(won.status).toBe(winner === "acceptance" ? 201 : 204);
      if (won.status === 204) await won.text(); else await won.json();
      expect(lost.status).toBe(409);
      expect((await lost.json()).error.code).toBe(
        winner === "acceptance" ? "INVITATION_ALREADY_ACCEPTED" : "INVITATION_UNAVAILABLE",
      );
      const [saved] = await savedInvitations(workspaceId);
      expect(saved.accepted_at !== null).toBe(winner === "acceptance");
      expect(saved.revoked_at !== null).toBe(winner === "revocation");
      expect(await membershipSnapshot(workspaceId)).toHaveLength(winner === "acceptance" ? 2 : 1);
    } finally {
      try { await locker.query("ROLLBACK"); } finally { locker.release(); }
      await Promise.all([first, second].map(async (request) => {
        if (request) await request.then((response) => response.text()).catch(() => {});
      }));
    }
  },
);

async function createProjectInWorkspace(workspaceId: number | string, body: unknown, token?: string) {
  return fetch(`${baseUrl}/workspaces/${workspaceId}/projects`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

async function workspaceProjects(workspaceId: number) {
  return (await pool!.query("SELECT * FROM projects WHERE workspace_id = $1 ORDER BY id", [workspaceId])).rows;
}

test.each(["owner", "editor"] as const)("an %s can create a workspace project without spoofing its workspace or creator", async (role) => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture("editor");
  const actorId = role === "owner" ? userIds[0] : userIds[1];
  const token = role === "owner" ? ownerToken : otherToken;
  const response = await createProjectInWorkspace(workspaceId, {
    name: "Shared project", description: "A collaborative project", status: "active",
    workspaceId: -1, workspace_id: -1, userId: -1, user_id: -1, createdBy: -1,
  }, token);
  expect(response.status).toBe(201);
  const body = await response.json();
  const [saved] = await workspaceProjects(workspaceId);
  expect(body).toEqual({ data: {
    id: saved.id, workspaceId, createdBy: actorId,
    name: "Shared project", description: "A collaborative project", status: "active",
    createdAt: saved.created_at.toISOString(),
  } });
  expect(saved.user_id).toBe(actorId);
  expect(saved.workspace_id).toBe(workspaceId);
});

test.each(["viewer", "outsider"] as const)("a %s cannot create workspace projects", async (role) => {
  const { workspaceId, otherToken } = await ownershipFixture(role);
  const response = await createProjectInWorkspace(workspaceId, { name: "Forbidden project", status: "active" }, otherToken);
  expect(response.status).toBe(role === "viewer" ? 403 : 404);
  expect((await response.json()).error.code).toBe(role === "viewer" ? "FORBIDDEN" : "NOT_FOUND");
  expect(await workspaceProjects(workspaceId)).toEqual([]);
});

test("workspace project creation requires authentication before validation", async () => {
  const response = await createProjectInWorkspace("invalid", {});
  expect(response.status).toBe(401);
  await response.text();
});

test("project creation in a missing workspace returns 404", async () => {
  const token = await login();
  expect((await pool!.query("SELECT id FROM workspaces WHERE id = 2147483647")).rows).toEqual([]);
  const response = await createProjectInWorkspace(2147483647, { name: "Missing workspace", status: "active" }, token);
  expect(response.status).toBe(404);
  expect((await response.json()).error.code).toBe("NOT_FOUND");
});

test("workspace projects support every valid status and an omitted description", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  for (const status of ["active", "inactive", "pending", "completed"]) {
    const response = await createProjectInWorkspace(workspaceId, { name: `Project ${status}`, status }, ownerToken);
    expect(response.status).toBe(201);
    expect((await response.json()).data).toMatchObject({ status, description: null });
  }
  expect(await workspaceProjects(workspaceId)).toHaveLength(4);
});

test("workspace project creation rejects invalid IDs and project fields", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  for (const invalid of ["abc", "0", "-1", "1.5", "2147483648"]) {
    const response = await createProjectInWorkspace(invalid, { name: "Valid project", status: "active" }, ownerToken);
    expect(response.status).toBe(422);
    expect((await response.json()).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "wid" }),
    ]));
  }
  const invalidFields = [
    { field: "name", value: undefined }, { field: "name", value: "ab" },
    { field: "name", value: 123 }, { field: "name", value: "x".repeat(101) },
    { field: "description", value: 123 }, { field: "description", value: "x".repeat(256) },
    { field: "status", value: undefined }, { field: "status", value: "owner" },
  ];
  for (const { field, value } of invalidFields) {
    const response = await createProjectInWorkspace(workspaceId, {
      name: "Valid project", status: "active", [field]: value,
    }, ownerToken);
    expect(response.status).toBe(422);
    expect((await response.json()).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field }),
    ]));
  }
  expect(await workspaceProjects(workspaceId)).toEqual([]);
});

test("failed workspace project insertion creates no project or membership changes", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const before = await membershipSnapshot(workspaceId);
  const constraint = `workspace_project_failure_${randomUUID().replace(/-/g, "")}`;
  try {
    await pool!.query(
      `ALTER TABLE projects ADD CONSTRAINT ${constraint} CHECK (workspace_id <> ${workspaceId}) NOT VALID`,
    );
    const response = await createProjectInWorkspace(workspaceId, { name: "Failed project", status: "active" }, ownerToken);
    expect(response.status).toBe(500);
    await response.json();
    expect(await workspaceProjects(workspaceId)).toEqual([]);
    expect(await membershipSnapshot(workspaceId)).toEqual(before);
  } finally {
    await pool!.query(`ALTER TABLE projects DROP CONSTRAINT IF EXISTS ${constraint}`);
  }
});

test("project creation rechecks membership after waiting for the workspace lock", async () => {
  const { workspaceId, otherToken } = await ownershipFixture("editor");
  const locker = await pool!.connect();
  let pending: Promise<Response> | undefined;
  try {
    await locker.query("BEGIN");
    const pid = await locker.query("SELECT pg_backend_pid() AS pid");
    await locker.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [workspaceId]);
    pending = createProjectInWorkspace(workspaceId, { name: "Stale editor project", status: "active" }, otherToken);
    void pending.catch(() => {});
    let blocked = false;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const waiting = await pool!.query(
        `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
         AND $1::int = ANY(pg_blocking_pids(pid))) AS blocked`, [pid.rows[0].pid],
      );
      if (waiting.rows[0].blocked) { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(blocked).toBe(true);
    await locker.query(
      "UPDATE workspace_members SET role = 'viewer' WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userIds[1]],
    );
    await locker.query("COMMIT");
    const response = await pending;
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("FORBIDDEN");
    expect(await workspaceProjects(workspaceId)).toEqual([]);
  } finally {
    try { await locker.query("ROLLBACK"); } finally { locker.release(); }
    if (pending) await pending.then((response) => response.text()).catch(() => {});
  }
});

async function listProjects(workspaceId: number | string, token?: string, cursor?: string) {
  const url = new URL(`${baseUrl}/workspaces/${workspaceId}/projects`);
  if (cursor !== undefined) url.searchParams.set("afterId", cursor);
  return fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5000),
  });
}

test.each(["owner", "editor", "viewer"] as const)("a workspace %s can list projects created by another member", async (role) => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture(role === "owner" ? "editor" : role);
  const creatorToken = role === "owner" ? otherToken : ownerToken;
  const readerToken = role === "owner" ? ownerToken : otherToken;
  const created = await createProjectInWorkspace(workspaceId, {
    name: "Shared team project", status: "active", description: "Visible to all members",
  }, creatorToken);
  expect(created.status).toBe(201);
  const { data: project } = await created.json();

  const response = await listProjects(workspaceId, readerToken);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: [project], page: { nextCursor: null } });
});

test("project lists are scoped to the URL workspace even when the user owns both", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const otherCreated = await create({ name: "Separate projects team" }, ownerToken);
  expect(otherCreated.status).toBe(201);
  const { data: other } = await otherCreated.json();
  const visibleResponse = await createProjectInWorkspace(workspaceId, { name: "Visible project", status: "active" }, ownerToken);
  const hiddenResponse = await createProjectInWorkspace(other.id, { name: "Hidden project", status: "pending" }, ownerToken);
  expect(visibleResponse.status).toBe(201);
  expect(hiddenResponse.status).toBe(201);
  const { data: visible } = await visibleResponse.json();
  await hiddenResponse.json();

  const response = await listProjects(workspaceId, ownerToken);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: [visible], page: { nextCursor: null } });
});

test("an empty workspace returns an empty project page", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const response = await listProjects(workspaceId, ownerToken);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: [], page: { nextCursor: null } });
});

test.each([20, 21])("project pagination handles %i records without omissions or repeats", async (count) => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const inserted = await pool!.query(
    `INSERT INTO projects (workspace_id, user_id, name, status)
     SELECT $1, $2, 'Project ' || n::text, 'active'
     FROM generate_series(1, $3::int) AS n RETURNING id`,
    [workspaceId, userIds[0], count],
  );
  const ids: number[] = inserted.rows.map((row) => row.id).sort((a, b) => a - b);
  const response = await listProjects(workspaceId, ownerToken, "0");
  expect(response.status).toBe(200);
  const first = await response.json();
  expect(first.data.map((row: { id: number }) => row.id)).toEqual(ids.slice(0, 20));
  expect(first.page.nextCursor).toBe(count === 21 ? ids[19] : null);
  if (count === 21) {
    const nextResponse = await listProjects(workspaceId, ownerToken, String(first.page.nextCursor));
    expect(nextResponse.status).toBe(200);
    const next = await nextResponse.json();
    expect(next.data.map((row: { id: number }) => row.id)).toEqual(ids.slice(20));
    expect(next.page.nextCursor).toBeNull();
  }
  const beyond = await listProjects(workspaceId, ownerToken, "2147483647");
  expect(beyond.status).toBe(200);
  expect(await beyond.json()).toEqual({ data: [], page: { nextCursor: null } });
});

test("outsiders cannot list private workspace projects", async () => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture("outsider");
  const created = await createProjectInWorkspace(workspaceId, { name: "Private project", status: "active" }, ownerToken);
  expect(created.status).toBe(201);
  await created.json();
  const response = await listProjects(workspaceId, otherToken);
  expect(response.status).toBe(404);
  const body = await response.json();
  expect(body.error.code).toBe("NOT_FOUND");
  expect(body.data).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain("Private project");
});

test("project listing requires authentication before validating the ID", async () => {
  const response = await listProjects("invalid");
  expect(response.status).toBe(401);
  await response.text();
});

test("listing projects in a nonexistent workspace returns 404", async () => {
  const token = await login();
  expect((await pool!.query("SELECT id FROM workspaces WHERE id = 2147483647")).rows).toEqual([]);
  const response = await listProjects(2147483647, token);
  expect(response.status).toBe(404);
  expect((await response.json()).error.code).toBe("NOT_FOUND");
});

test("project listing rejects invalid workspace IDs and cursors", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  for (const invalid of ["abc", "0", "-1", "1.5", "2147483648"]) {
    const response = await listProjects(invalid, ownerToken);
    expect(response.status).toBe(422);
    expect((await response.json()).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "wid" }),
    ]));
  }
  for (const invalid of ["abc", "-1", "1.5", "2147483648"]) {
    const response = await listProjects(workspaceId, ownerToken, invalid);
    expect(response.status).toBe(422);
    expect((await response.json()).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "afterId" }),
    ]));
  }
});

test("a removed project creator cannot list workspace projects with their existing token", async () => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture("editor");
  const created = await createProjectInWorkspace(workspaceId, { name: "Former member project", status: "active" }, otherToken);
  expect(created.status).toBe(201);
  const { data: project } = await created.json();
  const before = await listProjects(workspaceId, otherToken);
  expect(before.status).toBe(200);
  await before.json();
  const removed = await removeMember(workspaceId, userIds[1], ownerToken);
  expect(removed.status).toBe(204);
  await removed.text();

  const denied = await listProjects(workspaceId, otherToken);
  expect(denied.status).toBe(404);
  expect((await denied.json()).error.code).toBe("NOT_FOUND");
  const ownerResponse = await listProjects(workspaceId, ownerToken);
  expect(ownerResponse.status).toBe(200);
  expect(await ownerResponse.json()).toEqual({ data: [project], page: { nextCursor: null } });
});

async function getProject(workspaceId: number | string, projectId: number | string, token?: string) {
  return fetch(`${baseUrl}/workspaces/${workspaceId}/projects/${projectId}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5000),
  });
}

async function projectFixtureForHttp(workspaceId: number, token: string) {
  const response = await createProjectInWorkspace(workspaceId, {
    name: "Project detail fixture", description: "Only workspace members can read this", status: "active",
  }, token);
  expect(response.status).toBe(201);
  return (await response.json()).data;
}

test.each(["owner", "editor", "viewer"] as const)("a %s can read another member's workspace project", async (role) => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture(role === "owner" ? "editor" : role);
  const project = await projectFixtureForHttp(workspaceId, role === "owner" ? otherToken : ownerToken);
  const response = await getProject(workspaceId, project.id, role === "owner" ? ownerToken : otherToken);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: project });
});

test("an outsider cannot read a project by knowing both resource IDs", async () => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture("outsider");
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const response = await getProject(workspaceId, project.id, otherToken);
  expect(response.status).toBe(404);
  const body = await response.json();
  expect(body.error.code).toBe("NOT_FOUND");
  expect(body.data).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain(project.description);
});

test("project detail rejects mismatched workspace IDs even for an owner of both", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const created = await create({ name: "Different project workspace" }, ownerToken);
  expect(created.status).toBe(201);
  const { data: other } = await created.json();
  const response = await getProject(other.id, project.id, ownerToken);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: {
    code: "NOT_FOUND", message: "Project not found",
    requestId: response.headers.get("x-request-id"),
  } });
  expect(await workspaceProjects(workspaceId)).toHaveLength(1);
});

test("project detail authentication precedes validation", async () => {
  const response = await getProject("invalid", "invalid");
  expect(response.status).toBe(401);
  await response.text();
});

test("project detail returns 404 for missing workspace and missing project", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  expect((await pool!.query("SELECT id FROM workspaces WHERE id = 2147483647")).rows).toEqual([]);
  expect((await pool!.query("SELECT id FROM projects WHERE id = 2147483647")).rows).toEqual([]);
  for (const [wid, pid] of [[2147483647, project.id], [workspaceId, 2147483647]]) {
    const response = await getProject(wid, pid, ownerToken);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  }
});

test("project detail validates both route IDs without modifying the project", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const before = await workspaceProjects(workspaceId);
  for (const invalid of ["abc", "0", "-1", "1.5", "2147483648"]) {
    for (const field of ["wid", "pid"]) {
      const response = await getProject(
        field === "wid" ? invalid : workspaceId,
        field === "pid" ? invalid : project.id, ownerToken,
      );
      expect(response.status).toBe(422);
      expect((await response.json()).errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ field }),
      ]));
    }
  }
  expect(await workspaceProjects(workspaceId)).toEqual(before);
});

test("a removed creator loses project detail access while the workspace keeps the project", async () => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture("editor");
  const project = await projectFixtureForHttp(workspaceId, otherToken);
  const before = await getProject(workspaceId, project.id, otherToken);
  expect(before.status).toBe(200);
  await before.json();
  const removed = await removeMember(workspaceId, userIds[1], ownerToken);
  expect(removed.status).toBe(204);
  await removed.text();
  const denied = await getProject(workspaceId, project.id, otherToken);
  expect(denied.status).toBe(404);
  expect((await denied.json()).error.code).toBe("NOT_FOUND");
  const accessible = await getProject(workspaceId, project.id, ownerToken);
  expect(accessible.status).toBe(200);
  expect(await accessible.json()).toEqual({ data: project });
});

async function editProject(workspaceId: number | string, projectId: number | string, body: unknown, token?: string) {
  return fetch(`${baseUrl}/workspaces/${workspaceId}/projects/${projectId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

test.each(["owner", "editor"] as const)("an %s can update another member's project without changing ownership", async (role) => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture("editor");
  const project = await projectFixtureForHttp(workspaceId, role === "owner" ? otherToken : ownerToken);
  const response = await editProject(workspaceId, project.id, {
    name: "  Updated project  ", description: "Updated description", status: "completed",
    workspaceId: -1, workspace_id: -1, createdBy: -1, userId: -1, user_id: -1,
  }, role === "owner" ? ownerToken : otherToken);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: {
    ...project, name: "Updated project", description: "Updated description", status: "completed",
  } });
  const [saved] = await workspaceProjects(workspaceId);
  expect(saved).toMatchObject({
    id: project.id, workspace_id: workspaceId, user_id: project.createdBy,
    name: "Updated project", description: "Updated description", status: "completed",
  });
});

test("partial project updates preserve omitted fields and null explicitly clears description", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const renamed = await editProject(workspaceId, project.id, { name: "Renamed project" }, ownerToken);
  expect(renamed.status).toBe(200);
  expect(await renamed.json()).toEqual({ data: { ...project, name: "Renamed project" } });
  const cleared = await editProject(workspaceId, project.id, { description: null }, ownerToken);
  expect(cleared.status).toBe(200);
  const expected = { ...project, name: "Renamed project", description: null };
  expect(await cleared.json()).toEqual({ data: expected });
  const completed = await editProject(workspaceId, project.id, { status: "completed" }, ownerToken);
  expect(completed.status).toBe(200);
  expect(await completed.json()).toEqual({ data: { ...expected, status: "completed" } });
  expect((await workspaceProjects(workspaceId))[0]).toMatchObject({
    name: "Renamed project", description: null, status: "completed",
  });
});

test.each(["viewer", "outsider"] as const)("a %s cannot update workspace projects", async (role) => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture(role);
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const before = await workspaceProjects(workspaceId);
  const response = await editProject(workspaceId, project.id, { status: "completed" }, otherToken);
  expect(response.status).toBe(role === "viewer" ? 403 : 404);
  expect((await response.json()).error.code).toBe(role === "viewer" ? "FORBIDDEN" : "NOT_FOUND");
  expect(await workspaceProjects(workspaceId)).toEqual(before);
});

test("project updates require authentication before validation", async () => {
  const response = await editProject("invalid", "invalid", {});
  expect(response.status).toBe(401);
  await response.text();
});

test("project updates reject mismatched and missing resource IDs", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const created = await create({ name: "Other update team" }, ownerToken);
  expect(created.status).toBe(201);
  const { data: other } = await created.json();
  const before = await workspaceProjects(workspaceId);
  expect((await pool!.query("SELECT id FROM workspaces WHERE id = 2147483647")).rows).toEqual([]);
  expect((await pool!.query("SELECT id FROM projects WHERE id = 2147483647")).rows).toEqual([]);
  for (const [wid, pid] of [[other.id, project.id], [2147483647, project.id], [workspaceId, 2147483647]]) {
    const response = await editProject(wid, pid, { status: "completed" }, ownerToken);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  }
  expect(await workspaceProjects(workspaceId)).toEqual(before);
});

test.each([{}, { workspaceId: 123, createdBy: 123 }])("an update with no editable fields returns 422: %j", async (body) => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const before = await workspaceProjects(workspaceId);
  const response = await editProject(workspaceId, project.id, body, ownerToken);
  expect(response.status).toBe(422);
  expect((await response.json()).error.code).toBe("EMPTY_UPDATE");
  expect(await workspaceProjects(workspaceId)).toEqual(before);
});

test("project updates validate both IDs and supplied field values", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const before = await workspaceProjects(workspaceId);
  for (const invalid of ["abc", "0", "-1", "1.5", "2147483648"]) {
    for (const field of ["wid", "pid"]) {
      const response = await editProject(
        field === "wid" ? invalid : workspaceId,
        field === "pid" ? invalid : project.id, { status: "completed" }, ownerToken,
      );
      expect(response.status).toBe(422);
      expect((await response.json()).errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ field }),
      ]));
    }
  }
  for (const [field, value] of [
    ["name", null], ["name", ""], ["name", "   "], ["name", "ab"],
    ["name", "x".repeat(101)], ["name", 123],
    ["description", "x".repeat(256)], ["description", 123],
    ["status", "unknown"], ["status", null],
  ] as const) {
    const response = await editProject(workspaceId, project.id, { [field]: value }, ownerToken);
    expect(response.status).toBe(422);
    const body = await response.json();
    if (value === null) {
      // Vine treats null on optional, non-nullable fields as omitted.
      expect(body.error.code).toBe("EMPTY_UPDATE");
    } else {
      expect(body.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ field }),
      ]));
    }
  }
  expect(await workspaceProjects(workspaceId)).toEqual(before);
});

test("a failed project update leaves every project field unchanged", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const before = await workspaceProjects(workspaceId);
  const constraint = `project_update_failure_${randomUUID().replace(/-/g, "")}`;
  try {
    await pool!.query(
      `ALTER TABLE projects ADD CONSTRAINT ${constraint} CHECK (id <> ${project.id} OR status <> 'completed') NOT VALID`,
    );
    const response = await editProject(workspaceId, project.id, {
      name: "Rejected rename", description: null, status: "completed",
    }, ownerToken);
    expect(response.status).toBe(500);
    await response.json();
    expect(await workspaceProjects(workspaceId)).toEqual(before);
  } finally {
    await pool!.query(`ALTER TABLE projects DROP CONSTRAINT IF EXISTS ${constraint}`);
  }
});

test.each(["demoted", "removed"])("a waiting project update rechecks access after its editor is %s", async (change) => {
  const { workspaceId, otherToken } = await ownershipFixture("editor");
  const project = await projectFixtureForHttp(workspaceId, otherToken);
  const before = await workspaceProjects(workspaceId);
  const locker = await pool!.connect();
  let pending: Promise<Response> | undefined;
  try {
    await locker.query("BEGIN");
    const pid = await locker.query("SELECT pg_backend_pid() AS pid");
    await locker.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [workspaceId]);
    pending = editProject(workspaceId, project.id, { status: "completed" }, otherToken);
    void pending.catch(() => {});
    let blocked = false;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const waiting = await pool!.query(
        `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
         AND $1::int = ANY(pg_blocking_pids(pid))) AS blocked`, [pid.rows[0].pid],
      );
      if (waiting.rows[0].blocked) { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(blocked).toBe(true);
    await locker.query(
      change === "demoted"
        ? "UPDATE workspace_members SET role = 'viewer' WHERE workspace_id = $1 AND user_id = $2"
        : "DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userIds[1]],
    );
    await locker.query("COMMIT");
    const response = await pending;
    expect(response.status).toBe(change === "demoted" ? 403 : 404);
    expect((await response.json()).error.code).toBe(change === "demoted" ? "FORBIDDEN" : "NOT_FOUND");
    expect(await workspaceProjects(workspaceId)).toEqual(before);
  } finally {
    try { await locker.query("ROLLBACK"); } finally { locker.release(); }
    if (pending) await pending.then((response) => response.text()).catch(() => {});
  }
});

async function deleteProjectInWorkspace(workspaceId: number | string, projectId: number | string, token?: string) {
  return fetch(`${baseUrl}/workspaces/${workspaceId}/projects/${projectId}`, {
    method: "DELETE",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5000),
  });
}

async function waitForDatabaseBlocker(pid: number) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const waiting = await pool!.query(
      `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
       AND $1::int = ANY(pg_blocking_pids(pid))) AS blocked`, [pid],
    );
    if (waiting.rows[0].blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Expected request to wait for the test transaction's lock");
}

test("the owner can delete an editor's empty project without deleting another project", async () => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture("editor");
  const target = await projectFixtureForHttp(workspaceId, otherToken);
  const kept = await projectFixtureForHttp(workspaceId, ownerToken);
  const memberships = await membershipSnapshot(workspaceId);
  const response = await deleteProjectInWorkspace(workspaceId, target.id, ownerToken);
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
  expect((await workspaceProjects(workspaceId)).map((row) => row.id)).toEqual([kept.id]);
  expect(await membershipSnapshot(workspaceId)).toEqual(memberships);
  const repeated = await deleteProjectInWorkspace(workspaceId, target.id, ownerToken);
  expect(repeated.status).toBe(404);
  expect((await repeated.json()).error.code).toBe("NOT_FOUND");
});

test.each(["editor", "viewer", "outsider"] as const)("an %s cannot delete workspace projects", async (role) => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture(role);
  // Even a project creator must currently have owner authority to delete it.
  const project = await projectFixtureForHttp(workspaceId, role === "editor" ? otherToken : ownerToken);
  const before = await workspaceProjects(workspaceId);
  const response = await deleteProjectInWorkspace(workspaceId, project.id, otherToken);
  expect(response.status).toBe(role === "outsider" ? 404 : 403);
  expect((await response.json()).error.code).toBe(role === "outsider" ? "NOT_FOUND" : "FORBIDDEN");
  expect(await workspaceProjects(workspaceId)).toEqual(before);
});

test("deletion of a project containing tasks returns 409 and preserves all records", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const inserted = await pool!.query(
    "INSERT INTO tasks (project_id, title) VALUES ($1, 'Preserved task') RETURNING *", [project.id],
  );
  const before = await workspaceProjects(workspaceId);
  const response = await deleteProjectInWorkspace(workspaceId, project.id, ownerToken);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: {
    code: "PROJECT_NOT_EMPTY", message: "Remove the project's tasks before deleting it",
    requestId: response.headers.get("x-request-id"),
  } });
  expect(await workspaceProjects(workspaceId)).toEqual(before);
  expect((await pool!.query("SELECT * FROM tasks WHERE project_id = $1", [project.id])).rows)
    .toEqual(inserted.rows);
});

test("project deletion rejects mismatched workspaces and missing resources", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const created = await create({ name: "Other deletion workspace" }, ownerToken);
  expect(created.status).toBe(201);
  const { data: other } = await created.json();
  const before = await workspaceProjects(workspaceId);
  expect((await pool!.query("SELECT id FROM workspaces WHERE id = 2147483647")).rows).toEqual([]);
  expect((await pool!.query("SELECT id FROM projects WHERE id = 2147483647")).rows).toEqual([]);
  for (const [wid, pid] of [[other.id, project.id], [workspaceId, 2147483647], [2147483647, project.id]]) {
    const response = await deleteProjectInWorkspace(wid, pid, ownerToken);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  }
  expect(await workspaceProjects(workspaceId)).toEqual(before);
});

test("project deletion validates both route IDs without changing records", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const before = await workspaceProjects(workspaceId);
  for (const invalid of ["abc", "0", "-1", "1.5", "2147483648"]) {
    for (const field of ["wid", "pid"]) {
      const response = await deleteProjectInWorkspace(
        field === "wid" ? invalid : workspaceId,
        field === "pid" ? invalid : project.id, ownerToken,
      );
      expect(response.status).toBe(422);
      expect((await response.json()).errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ field }),
      ]));
    }
  }
  expect(await workspaceProjects(workspaceId)).toEqual(before);
});

test("project deletion requires authentication before validating IDs", async () => {
  const response = await deleteProjectInWorkspace("invalid", "invalid");
  expect(response.status).toBe(401);
  await response.text();
});

test("concurrent deletions delete one project and return 404 to the later request", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const responses = await Promise.all([
    deleteProjectInWorkspace(workspaceId, project.id, ownerToken),
    deleteProjectInWorkspace(workspaceId, project.id, ownerToken),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([204, 404]);
  await Promise.all(responses.map((response) => response.text()));
  expect(await workspaceProjects(workspaceId)).toEqual([]);
});

test.each(["demoted", "removed"])("a waiting deletion rechecks authority after its owner is %s", async (change) => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const before = await workspaceProjects(workspaceId);
  const locker = await pool!.connect();
  let pending: Promise<Response> | undefined;
  try {
    await locker.query("BEGIN");
    const pid = await locker.query("SELECT pg_backend_pid() AS pid");
    await locker.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [workspaceId]);
    pending = deleteProjectInWorkspace(workspaceId, project.id, ownerToken);
    void pending.catch(() => {});
    await waitForDatabaseBlocker(pid.rows[0].pid);
    // Transfer ownership first, then optionally remove the former owner.
    await locker.query("UPDATE workspace_members SET role = 'editor' WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userIds[0]]);
    await locker.query("UPDATE workspace_members SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userIds[1]]);
    if (change === "removed") {
      await locker.query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userIds[0]]);
    }
    await locker.query("COMMIT");
    const response = await pending;
    expect(response.status).toBe(change === "demoted" ? 403 : 404);
    await response.json();
    expect(await workspaceProjects(workspaceId)).toEqual(before);
  } finally {
    try { await locker.query("ROLLBACK"); } finally { locker.release(); }
    if (pending) await pending.then((response) => response.text()).catch(() => {});
  }
});

test("the foreign key protects a task inserted by a legacy writer during project deletion", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const writer = await pool!.connect();
  let pending: Promise<Response> | undefined;
  try {
    await writer.query("BEGIN");
    const pid = await writer.query("SELECT pg_backend_pid() AS pid");
    // Uncommitted task is invisible to projectHasTasks, but blocks deletion.
    const inserted = await writer.query(
      "INSERT INTO tasks (project_id, title) VALUES ($1, 'Concurrent legacy task') RETURNING id", [project.id],
    );
    pending = deleteProjectInWorkspace(workspaceId, project.id, ownerToken);
    void pending.catch(() => {});
    await waitForDatabaseBlocker(pid.rows[0].pid);
    await writer.query("COMMIT");
    const response = await pending;
    // The user chose to leave the optional 409 translation commented out.
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false, message: "Internal server error", requestId: response.headers.get("x-request-id"),
    });
    expect((await workspaceProjects(workspaceId)).map((row) => row.id)).toEqual([project.id]);
    expect((await pool!.query("SELECT id FROM tasks WHERE project_id = $1", [project.id])).rows)
      .toEqual(inserted.rows);
  } finally {
    try { await writer.query("ROLLBACK"); } finally { writer.release(); }
    if (pending) await pending.then((response) => response.text()).catch(() => {});
  }
});

test("legacy project URLs cannot create personal or workspace projects", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  for (const path of ["/users/projects", `/users/projects/${workspaceId}/projects`]) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ name: "Legacy creation attempt", status: "active", workspaceId }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(404);
    await response.text();
  }
  expect((await pool!.query(
    "SELECT id FROM projects WHERE user_id = ANY($1::int[])", [userIds],
  )).rows).toEqual([]);

  const created = await createProjectInWorkspace(workspaceId, {
    name: "Workspace-only project", status: "active",
  }, ownerToken);
  expect(created.status).toBe(201);
  expect((await created.json()).data.workspaceId).toBe(workspaceId);
  expect(await workspaceProjects(workspaceId)).toHaveLength(1);
});

test("a removed creator cannot bypass workspace checks through retired project or task routes", async () => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture("editor");
  const project = await projectFixtureForHttp(workspaceId, otherToken);
  const tasks = await pool!.query(
    "INSERT INTO tasks (project_id, title) VALUES ($1, 'Workspace-isolated task') RETURNING *", [project.id],
  );
  const taskId = tasks.rows[0].id;
  const removed = await removeMember(workspaceId, userIds[1], ownerToken);
  expect(removed.status).toBe(204);
  await removed.text();
  const projects = await workspaceProjects(workspaceId);
  for (const [method, path] of [
    ["GET", "/users/projects"],
    ["GET", `/users/projects/${project.id}`],
    ["PATCH", `/users/projects/${project.id}`],
    ["DELETE", `/users/projects/${project.id}`],
    ["GET", `/projects/${project.id}/tasks`],
    ["GET", `/projects/${project.id}/tasks/${taskId}`],
    ["POST", `/projects/${project.id}/tasks`],
    ["PATCH", `/projects/${project.id}/tasks/${taskId}`],
    ["DELETE", `/projects/${project.id}/tasks/${taskId}`],
  ] as const) {
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers: { authorization: `Bearer ${otherToken}` },
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  }
  expect(await workspaceProjects(workspaceId)).toEqual(projects);
  expect((await pool!.query("SELECT * FROM tasks WHERE id = $1", [taskId])).rows).toEqual(tasks.rows);
  const denied = await getProject(workspaceId, project.id, otherToken);
  expect(denied.status).toBe(404);
  await denied.json();
  const allowed = await getProject(workspaceId, project.id, ownerToken);
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toEqual({ data: project });
});

async function listProjectTasks(workspaceId: number | string, projectId: number | string, token?: string, cursor?: string) {
  const url = new URL(`${baseUrl}/workspaces/${workspaceId}/projects/${projectId}/tasks`);
  if (cursor !== undefined) url.searchParams.set("afterId", cursor);
  return fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5000),
  });
}

async function insertTaskFixture(projectId: number, title = "Workspace task fixture") {
  const result = await pool!.query(
    "INSERT INTO tasks (project_id, title, description, status) VALUES ($1, $2, 'Task description', 'on progress') RETURNING *",
    [projectId, title],
  );
  return result.rows[0];
}

test.each(["owner", "editor", "viewer"] as const)("a workspace %s can read project tasks with task-specific fields", async (role) => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture(role === "owner" ? "editor" : role);
  const project = await projectFixtureForHttp(workspaceId, role === "owner" ? otherToken : ownerToken);
  const task = await insertTaskFixture(project.id);
  const response = await listProjectTasks(workspaceId, project.id, role === "owner" ? ownerToken : otherToken);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: [{
    id: task.id, projectId: project.id, title: task.title, description: task.description,
    status: task.status, createdAt: task.created_at.toISOString(),
  }], page: { nextCursor: null } });
});

test("task lists are scoped to both project and workspace, even for a member of both", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const sibling = await projectFixtureForHttp(workspaceId, ownerToken);
  const visible = await insertTaskFixture(project.id, "Visible task");
  await insertTaskFixture(sibling.id, "Sibling project task");
  const created = await create({ name: "Separate task workspace" }, ownerToken);
  expect(created.status).toBe(201);
  const { data: other } = await created.json();
  const otherProject = await projectFixtureForHttp(other.id, ownerToken);
  await insertTaskFixture(otherProject.id, "Other workspace task");

  const response = await listProjectTasks(workspaceId, project.id, ownerToken);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.data).toEqual([expect.objectContaining({ id: visible.id, title: "Visible task" })]);
  expect(body.page.nextCursor).toBeNull();
  for (const [wid, pid] of [[workspaceId, otherProject.id], [other.id, project.id]]) {
    const mismatch = await listProjectTasks(wid, pid, ownerToken);
    expect(mismatch.status).toBe(404);
    expect((await mismatch.json()).error.code).toBe("NOT_FOUND");
  }
});

test("a project without tasks returns an empty task page", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const response = await listProjectTasks(workspaceId, project.id, ownerToken);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: [], page: { nextCursor: null } });
});

test.each([20, 21])("task pagination handles %i records without duplicates or omissions", async (count) => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const inserted = await pool!.query(
    `INSERT INTO tasks (project_id, title) SELECT $1, 'Task ' || n::text
     FROM generate_series(1, $2::int) AS n RETURNING id`, [project.id, count],
  );
  const ids: number[] = inserted.rows.map((row) => row.id).sort((a, b) => a - b);
  const firstResponse = await listProjectTasks(workspaceId, project.id, ownerToken, "0");
  expect(firstResponse.status).toBe(200);
  const first = await firstResponse.json();
  expect(first.data.map((task: { id: number }) => task.id)).toEqual(ids.slice(0, 20));
  expect(first.page.nextCursor).toBe(count === 21 ? ids[19] : null);
  if (count === 21) {
    const secondResponse = await listProjectTasks(workspaceId, project.id, ownerToken, String(first.page.nextCursor));
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json();
    expect(second.data.map((task: { id: number }) => task.id)).toEqual(ids.slice(20));
    expect(second.page.nextCursor).toBeNull();
  }
  const beyond = await listProjectTasks(workspaceId, project.id, ownerToken, "2147483647");
  expect(beyond.status).toBe(200);
  expect(await beyond.json()).toEqual({ data: [], page: { nextCursor: null } });
});

test("outsiders cannot list tasks by knowing workspace and project IDs", async () => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture("outsider");
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  await insertTaskFixture(project.id, "Private workspace task");
  const response = await listProjectTasks(workspaceId, project.id, otherToken);
  expect(response.status).toBe(404);
  const body = await response.json();
  expect(body.error.code).toBe("NOT_FOUND");
  expect(body.data).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain("Private workspace task");
});

test("task listing requires authentication before validating route IDs", async () => {
  const response = await listProjectTasks("invalid", "invalid");
  expect(response.status).toBe(401);
  await response.text();
});

test("missing workspace or project returns 404 instead of an empty task page", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  expect((await pool!.query("SELECT id FROM workspaces WHERE id = 2147483647")).rows).toEqual([]);
  expect((await pool!.query("SELECT id FROM projects WHERE id = 2147483647")).rows).toEqual([]);
  for (const [wid, pid] of [[workspaceId, 2147483647], [2147483647, project.id]]) {
    const response = await listProjectTasks(wid, pid, ownerToken);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  }
});

test("task listing validates workspace/project IDs and pagination cursors", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  for (const invalid of ["abc", "0", "-1", "1.5", "2147483648"]) {
    for (const field of ["wid", "pid"]) {
      const response = await listProjectTasks(
        field === "wid" ? invalid : workspaceId,
        field === "pid" ? invalid : project.id, ownerToken,
      );
      expect(response.status).toBe(422);
      expect((await response.json()).errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ field }),
      ]));
    }
  }
  for (const invalid of ["abc", "-1", "1.5", "2147483648"]) {
    const response = await listProjectTasks(workspaceId, project.id, ownerToken, invalid);
    expect(response.status).toBe(422);
    expect((await response.json()).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "afterId" }),
    ]));
  }
});

test("removed project creators lose task-list access with their existing token", async () => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture("editor");
  const project = await projectFixtureForHttp(workspaceId, otherToken);
  const task = await insertTaskFixture(project.id);
  const before = await listProjectTasks(workspaceId, project.id, otherToken);
  expect(before.status).toBe(200);
  await before.json();
  const removed = await removeMember(workspaceId, userIds[1], ownerToken);
  expect(removed.status).toBe(204);
  await removed.text();
  const denied = await listProjectTasks(workspaceId, project.id, otherToken);
  expect(denied.status).toBe(404);
  expect((await denied.json()).error.code).toBe("NOT_FOUND");
  const accessible = await listProjectTasks(workspaceId, project.id, ownerToken);
  expect(accessible.status).toBe(200);
  expect((await accessible.json()).data).toEqual([expect.objectContaining({ id: task.id })]);
});

async function getTask(workspaceId: number | string, projectId: number | string, taskId: number | string, token?: string) {
  return fetch(`${baseUrl}/workspaces/${workspaceId}/projects/${projectId}/tasks/${taskId}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5000),
  });
}

function taskResponse(task: { id: number; project_id: number; title: string; description: string | null; status: string | null; created_at: Date }) {
  return {
    id: task.id, projectId: task.project_id, title: task.title,
    description: task.description, status: task.status, createdAt: task.created_at.toISOString(),
  };
}

test.each(["owner", "editor", "viewer"] as const)("a %s can read a workspace task with the task's own fields", async (role) => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture(role === "owner" ? "editor" : role);
  const project = await projectFixtureForHttp(workspaceId, role === "owner" ? otherToken : ownerToken);
  const task = await insertTaskFixture(project.id);
  const response = await getTask(workspaceId, project.id, task.id, role === "owner" ? ownerToken : otherToken);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: taskResponse(task) });
});

test("outsiders cannot retrieve task details with known workspace, project, and task IDs", async () => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture("outsider");
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const task = await insertTaskFixture(project.id, "Private task details");
  const response = await getTask(workspaceId, project.id, task.id, otherToken);
  expect(response.status).toBe(404);
  const body = await response.json();
  expect(body.error.code).toBe("NOT_FOUND");
  expect(body.data).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain(task.title);
});

test("task detail rejects mismatched project/workspace/task combinations", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const sibling = await projectFixtureForHttp(workspaceId, ownerToken);
  const task = await insertTaskFixture(project.id);
  const siblingTask = await insertTaskFixture(sibling.id);
  const created = await create({ name: "Another task detail team" }, ownerToken);
  expect(created.status).toBe(201);
  const { data: other } = await created.json();
  const otherProject = await projectFixtureForHttp(other.id, ownerToken);
  const otherTask = await insertTaskFixture(otherProject.id);
  for (const [wid, pid, tid] of [
    [workspaceId, sibling.id, task.id], [workspaceId, project.id, siblingTask.id],
    [other.id, project.id, task.id], [workspaceId, otherProject.id, otherTask.id],
    [workspaceId, project.id, otherTask.id],
  ]) {
    const response = await getTask(wid, pid, tid, ownerToken);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.data).toBeUndefined();
  }
});

test("task detail requires authentication before route validation", async () => {
  const response = await getTask("invalid", "invalid", "invalid");
  expect(response.status).toBe(401);
  await response.text();
});

test("task detail returns 404 for each missing level of the resource hierarchy", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const task = await insertTaskFixture(project.id);
  for (const table of ["workspaces", "projects", "tasks"]) {
    expect((await pool!.query(`SELECT id FROM ${table} WHERE id = 2147483647`)).rows).toEqual([]);
  }
  for (const [wid, pid, tid] of [
    [2147483647, project.id, task.id], [workspaceId, 2147483647, task.id], [workspaceId, project.id, 2147483647],
  ]) {
    const response = await getTask(wid, pid, tid, ownerToken);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  }
});

test("task detail validates all three route IDs without changing records", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const task = await insertTaskFixture(project.id);
  for (const invalid of ["abc", "0", "-1", "1.5", "2147483648"]) {
    for (const field of ["wid", "pid", "tid"]) {
      const response = await getTask(
        field === "wid" ? invalid : workspaceId,
        field === "pid" ? invalid : project.id,
        field === "tid" ? invalid : task.id, ownerToken,
      );
      expect(response.status).toBe(422);
      expect((await response.json()).errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ field }),
      ]));
    }
  }
  expect((await pool!.query("SELECT * FROM tasks WHERE id = $1", [task.id])).rows).toEqual([task]);
});

test("removed creators lose task-detail access, while the owner retains access", async () => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture("editor");
  const project = await projectFixtureForHttp(workspaceId, otherToken);
  const task = await insertTaskFixture(project.id);
  const before = await getTask(workspaceId, project.id, task.id, otherToken);
  expect(before.status).toBe(200);
  await before.json();
  const removed = await removeMember(workspaceId, userIds[1], ownerToken);
  expect(removed.status).toBe(204);
  await removed.text();
  const denied = await getTask(workspaceId, project.id, task.id, otherToken);
  expect(denied.status).toBe(404);
  expect((await denied.json()).error.code).toBe("NOT_FOUND");
  const allowed = await getTask(workspaceId, project.id, task.id, ownerToken);
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toEqual({ data: taskResponse(task) });
});

async function createTaskInWorkspace(workspaceId: number | string, projectId: number | string, body: unknown, token?: string) {
  return fetch(`${baseUrl}/workspaces/${workspaceId}/projects/${projectId}/tasks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

async function savedProjectTasks(projectId: number) {
  return (await pool!.query("SELECT * FROM tasks WHERE project_id = $1 ORDER BY id", [projectId])).rows;
}

test.each(["owner", "editor"] as const)("a workspace %s can create a task without spoofing its project", async (role) => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture("editor");
  const project = await projectFixtureForHttp(workspaceId, role === "owner" ? otherToken : ownerToken);
  const before = await workspaceProjects(workspaceId);
  const response = await createTaskInWorkspace(workspaceId, project.id, {
    title: "  Shared task  ", description: "Task content", status: "on progress",
    projectId: -1, project_id: -1, workspaceId: -1, createdBy: -1, userId: -1,
  }, role === "owner" ? ownerToken : otherToken);
  expect(response.status).toBe(201);
  const [task] = await savedProjectTasks(project.id);
  expect(await response.json()).toEqual({ data: taskResponse(task) });
  expect(task).toMatchObject({ project_id: project.id, title: "Shared task", description: "Task content", status: "on progress" });
  const after = await workspaceProjects(workspaceId);
  expect(BigInt(after[0].task_cache_version)).toBe(BigInt(before[0].task_cache_version) + 1n);
});

test.each(["viewer", "outsider"] as const)("a %s cannot create workspace tasks", async (role) => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture(role);
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const before = await workspaceProjects(workspaceId);
  const response = await createTaskInWorkspace(workspaceId, project.id, { title: "Forbidden task", status: "done" }, otherToken);
  expect(response.status).toBe(role === "viewer" ? 403 : 404);
  expect((await response.json()).error.code).toBe(role === "viewer" ? "FORBIDDEN" : "NOT_FOUND");
  expect(await savedProjectTasks(project.id)).toEqual([]);
  expect(await workspaceProjects(workspaceId)).toEqual(before);
});

test("task creation rejects another workspace's project and missing resources", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const created = await create({ name: "Other task creation team" }, ownerToken);
  expect(created.status).toBe(201);
  const { data: other } = await created.json();
  expect((await pool!.query("SELECT id FROM workspaces WHERE id = 2147483647")).rows).toEqual([]);
  expect((await pool!.query("SELECT id FROM projects WHERE id = 2147483647")).rows).toEqual([]);
  for (const [wid, pid] of [[other.id, project.id], [2147483647, project.id], [workspaceId, 2147483647]]) {
    const response = await createTaskInWorkspace(wid, pid, { title: "Wrong project task", status: "done" }, ownerToken);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  }
  expect(await savedProjectTasks(project.id)).toEqual([]);
});

test("workspace task creation requires authentication before validation", async () => {
  const response = await createTaskInWorkspace("invalid", "invalid", {});
  expect(response.status).toBe(401);
  await response.text();
});

test("task creation supports each valid status, optional descriptions, and exact column limits", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  for (const status of ["done", "cancelled", "on progress"]) {
    const response = await createTaskInWorkspace(workspaceId, project.id, { title: `Task ${status}`, status }, ownerToken);
    expect(response.status).toBe(201);
    expect((await response.json()).data).toMatchObject({ projectId: project.id, status, description: null });
  }
  const response = await createTaskInWorkspace(workspaceId, project.id, {
    title: "x".repeat(50), description: "x".repeat(255), status: "done",
  }, ownerToken);
  expect(response.status).toBe(201);
  expect((await response.json()).data).toMatchObject({ title: "x".repeat(50), description: "x".repeat(255) });
  expect(await savedProjectTasks(project.id)).toHaveLength(4);
});

test("task creation validates IDs and content without creating rows or changing cache versions", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const before = await workspaceProjects(workspaceId);
  for (const invalid of ["abc", "0", "-1", "1.5", "2147483648"]) {
    for (const field of ["wid", "pid"]) {
      const response = await createTaskInWorkspace(
        field === "wid" ? invalid : workspaceId,
        field === "pid" ? invalid : project.id, { title: "Valid task", status: "done" }, ownerToken,
      );
      expect(response.status).toBe(422);
      expect((await response.json()).errors).toEqual(expect.arrayContaining([expect.objectContaining({ field })]));
    }
  }
  for (const [field, value] of [
    ["title", undefined], ["title", null], ["title", ""], ["title", "   "],
    ["title", "ab"], ["title", "x".repeat(51)], ["title", 123],
    ["description", "x".repeat(256)], ["description", 123],
    ["status", undefined], ["status", null], ["status", "active"],
  ] as const) {
    const response = await createTaskInWorkspace(workspaceId, project.id, { title: "Valid task", status: "done", [field]: value }, ownerToken);
    expect(response.status).toBe(422);
    expect((await response.json()).errors).toEqual(expect.arrayContaining([expect.objectContaining({ field })]));
  }
  expect(await savedProjectTasks(project.id)).toEqual([]);
  expect(await workspaceProjects(workspaceId)).toEqual(before);
});

test("failed task insertion rolls back without changing the project's cache version", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const before = await workspaceProjects(workspaceId);
  const constraint = `task_create_failure_${randomUUID().replace(/-/g, "")}`;
  try {
    await pool!.query(`ALTER TABLE tasks ADD CONSTRAINT ${constraint} CHECK (project_id <> ${project.id}) NOT VALID`);
    const response = await createTaskInWorkspace(workspaceId, project.id, { title: "Rejected task", status: "done" }, ownerToken);
    expect(response.status).toBe(500);
    await response.json();
    expect(await savedProjectTasks(project.id)).toEqual([]);
    expect(await workspaceProjects(workspaceId)).toEqual(before);
  } finally {
    await pool!.query(`ALTER TABLE tasks DROP CONSTRAINT IF EXISTS ${constraint}`);
  }
});

test.each(["demoted", "removed"])("waiting task creation rechecks membership after its editor is %s", async (change) => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture("editor");
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const before = await workspaceProjects(workspaceId);
  const locker = await pool!.connect();
  let pending: Promise<Response> | undefined;
  try {
    await locker.query("BEGIN");
    const pid = await locker.query("SELECT pg_backend_pid() AS pid");
    await locker.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [workspaceId]);
    pending = createTaskInWorkspace(workspaceId, project.id, { title: "Stale permission task", status: "done" }, otherToken);
    void pending.catch(() => {});
    await waitForDatabaseBlocker(pid.rows[0].pid);
    await locker.query(
      change === "demoted"
        ? "UPDATE workspace_members SET role = 'viewer' WHERE workspace_id = $1 AND user_id = $2"
        : "DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userIds[1]],
    );
    await locker.query("COMMIT");
    const response = await pending;
    expect(response.status).toBe(change === "demoted" ? 403 : 404);
    await response.json();
    expect(await savedProjectTasks(project.id)).toEqual([]);
    expect(await workspaceProjects(workspaceId)).toEqual(before);
  } finally {
    try { await locker.query("ROLLBACK"); } finally { locker.release(); }
    if (pending) await pending.then((response) => response.text()).catch(() => {});
  }
});

async function editTask(workspaceId: number | string, projectId: number | string, taskId: number | string, body: unknown, token?: string) {
  return fetch(`${baseUrl}/workspaces/${workspaceId}/projects/${projectId}/tasks/${taskId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

test.each(["owner", "editor"] as const)("an %s can update a task without changing its project", async (role) => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture("editor");
  const project = await projectFixtureForHttp(workspaceId, role === "owner" ? otherToken : ownerToken);
  const task = await insertTaskFixture(project.id);
  const before = await workspaceProjects(workspaceId);
  const response = await editTask(workspaceId, project.id, task.id, {
    title: "  Updated task  ", description: "Updated task content", status: "done",
    projectId: -1, project_id: -1, workspaceId: -1, id: -1,
  }, role === "owner" ? ownerToken : otherToken);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: {
    ...taskResponse(task), title: "Updated task", description: "Updated task content", status: "done",
  } });
  expect(await savedProjectTasks(project.id)).toEqual([
    { ...task, title: "Updated task", description: "Updated task content", status: "done" },
  ]);
  const after = await workspaceProjects(workspaceId);
  expect(BigInt(after[0].task_cache_version)).toBe(BigInt(before[0].task_cache_version) + 1n);
});

test("partial task updates preserve omitted fields and clear descriptions with null", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const task = await insertTaskFixture(project.id);
  const renamed = await editTask(workspaceId, project.id, task.id, { title: "Renamed task" }, ownerToken);
  expect(renamed.status).toBe(200);
  expect(await renamed.json()).toEqual({ data: { ...taskResponse(task), title: "Renamed task" } });
  const cleared = await editTask(workspaceId, project.id, task.id, { description: null }, ownerToken);
  expect(cleared.status).toBe(200);
  const expected = { ...taskResponse(task), title: "Renamed task", description: null };
  expect(await cleared.json()).toEqual({ data: expected });
  for (const status of ["done", "cancelled", "on progress"]) {
    const response = await editTask(workspaceId, project.id, task.id, { status }, ownerToken);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { ...expected, status } });
  }
  expect(await savedProjectTasks(project.id)).toEqual([
    { ...task, title: "Renamed task", description: null, status: "on progress" },
  ]);
});

test.each(["viewer", "outsider"] as const)("a %s cannot update workspace tasks", async (role) => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture(role);
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const task = await insertTaskFixture(project.id);
  const before = await workspaceProjects(workspaceId);
  const response = await editTask(workspaceId, project.id, task.id, { status: "done" }, otherToken);
  expect(response.status).toBe(role === "viewer" ? 403 : 404);
  expect((await response.json()).error.code).toBe(role === "viewer" ? "FORBIDDEN" : "NOT_FOUND");
  expect(await savedProjectTasks(project.id)).toEqual([task]);
  expect(await workspaceProjects(workspaceId)).toEqual(before);
});

test("task updates require authentication before validation", async () => {
  const response = await editTask("invalid", "invalid", "invalid", {});
  expect(response.status).toBe(401);
  await response.text();
});

test("task updates reject mismatched hierarchy and missing resources without changing records", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const sibling = await projectFixtureForHttp(workspaceId, ownerToken);
  const task = await insertTaskFixture(project.id);
  const created = await create({ name: "Other task update team" }, ownerToken);
  expect(created.status).toBe(201);
  const { data: other } = await created.json();
  const otherProject = await projectFixtureForHttp(other.id, ownerToken);
  const before = await workspaceProjects(workspaceId);
  for (const table of ["workspaces", "projects", "tasks"]) {
    expect((await pool!.query(`SELECT id FROM ${table} WHERE id = 2147483647`)).rows).toEqual([]);
  }
  for (const [wid, pid, tid] of [
    [workspaceId, sibling.id, task.id], [other.id, project.id, task.id],
    [workspaceId, otherProject.id, task.id], [2147483647, project.id, task.id],
    [workspaceId, 2147483647, task.id], [workspaceId, project.id, 2147483647],
  ]) {
    const response = await editTask(wid, pid, tid, { status: "done" }, ownerToken);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  }
  expect(await savedProjectTasks(project.id)).toEqual([task]);
  expect(await workspaceProjects(workspaceId)).toEqual(before);
});

test.each([{}, { projectId: 123, workspaceId: 123 }])("task updates require editable fields: %j", async (body) => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const task = await insertTaskFixture(project.id);
  const response = await editTask(workspaceId, project.id, task.id, body, ownerToken);
  expect(response.status).toBe(422);
  expect((await response.json()).error.code).toBe("EMPTY_UPDATE");
  expect(await savedProjectTasks(project.id)).toEqual([task]);
});

test("task updates validate all route IDs and field limits without changing cache versions", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const task = await insertTaskFixture(project.id);
  const before = await workspaceProjects(workspaceId);
  for (const invalid of ["abc", "0", "-1", "1.5", "2147483648"]) {
    for (const field of ["wid", "pid", "tid"]) {
      const response = await editTask(
        field === "wid" ? invalid : workspaceId, field === "pid" ? invalid : project.id,
        field === "tid" ? invalid : task.id, { status: "done" }, ownerToken,
      );
      expect(response.status).toBe(422);
      expect((await response.json()).errors).toEqual(expect.arrayContaining([expect.objectContaining({ field })]));
    }
  }
  for (const [field, value] of [
    ["title", null], ["title", ""], ["title", "   "], ["title", "ab"],
    ["title", "x".repeat(51)], ["title", 123],
    ["description", "x".repeat(256)], ["description", 123],
    ["status", null], ["status", "active"],
  ] as const) {
    const response = await editTask(workspaceId, project.id, task.id, { [field]: value }, ownerToken);
    expect(response.status).toBe(422);
    const body = await response.json();
    if (value === null) expect(body.error.code).toBe("EMPTY_UPDATE");
    else expect(body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ field })]));
  }
  expect(await savedProjectTasks(project.id)).toEqual([task]);
  expect(await workspaceProjects(workspaceId)).toEqual(before);
});

test("failed task updates roll back content and cache-version changes", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const task = await insertTaskFixture(project.id);
  const before = await workspaceProjects(workspaceId);
  const constraint = `task_update_failure_${randomUUID().replace(/-/g, "")}`;
  try {
    await pool!.query(`ALTER TABLE tasks ADD CONSTRAINT ${constraint} CHECK (id <> ${task.id} OR status <> 'done') NOT VALID`);
    const response = await editTask(workspaceId, project.id, task.id, { title: "Rejected edit", description: null, status: "done" }, ownerToken);
    expect(response.status).toBe(500);
    await response.json();
    expect(await savedProjectTasks(project.id)).toEqual([task]);
    expect(await workspaceProjects(workspaceId)).toEqual(before);
  } finally {
    await pool!.query(`ALTER TABLE tasks DROP CONSTRAINT IF EXISTS ${constraint}`);
  }
});

test.each(["demoted", "removed"])("a waiting task update rechecks permission after its editor is %s", async (change) => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture("editor");
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const task = await insertTaskFixture(project.id);
  const before = await workspaceProjects(workspaceId);
  const locker = await pool!.connect();
  let pending: Promise<Response> | undefined;
  try {
    await locker.query("BEGIN");
    const pid = await locker.query("SELECT pg_backend_pid() AS pid");
    await locker.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [workspaceId]);
    pending = editTask(workspaceId, project.id, task.id, { status: "done" }, otherToken);
    void pending.catch(() => {});
    await waitForDatabaseBlocker(pid.rows[0].pid);
    await locker.query(
      change === "demoted" ? "UPDATE workspace_members SET role = 'viewer' WHERE workspace_id = $1 AND user_id = $2"
        : "DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userIds[1]],
    );
    await locker.query("COMMIT");
    const response = await pending;
    expect(response.status).toBe(change === "demoted" ? 403 : 404);
    await response.json();
    expect(await savedProjectTasks(project.id)).toEqual([task]);
    expect(await workspaceProjects(workspaceId)).toEqual(before);
  } finally {
    try { await locker.query("ROLLBACK"); } finally { locker.release(); }
    if (pending) await pending.then((response) => response.text()).catch(() => {});
  }
});

async function deleteTaskInWorkspace(
  workspaceId: number | string,
  projectId: number | string,
  taskId: number | string,
  token?: string,
) {
  return fetch(`${baseUrl}/workspaces/${workspaceId}/projects/${projectId}/tasks/${taskId}`, {
    method: "DELETE",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5000),
  });
}

test.each(["owner", "editor"] as const)("an %s can delete a task while preserving its siblings and project", async (role) => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture("editor");
  const project = await projectFixtureForHttp(workspaceId, role === "owner" ? otherToken : ownerToken);
  const task = await insertTaskFixture(project.id);
  const sibling = await insertTaskFixture(project.id, "Preserved sibling");
  const before = await workspaceProjects(workspaceId);
  const token = role === "owner" ? ownerToken : otherToken;
  const response = await deleteTaskInWorkspace(workspaceId, project.id, task.id, token);
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
  expect(await savedProjectTasks(project.id)).toEqual([sibling]);
  const after = await workspaceProjects(workspaceId);
  expect(after).toHaveLength(1);
  expect(after[0]).toEqual({ ...before[0], task_cache_version: (BigInt(before[0].task_cache_version) + 1n).toString() });

  const repeated = await deleteTaskInWorkspace(workspaceId, project.id, task.id, token);
  expect(repeated.status).toBe(404);
  expect((await repeated.json()).error.code).toBe("NOT_FOUND");
  expect(await workspaceProjects(workspaceId)).toEqual(after);
});

test.each(["viewer", "outsider"] as const)("a %s cannot delete workspace tasks", async (role) => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture(role);
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const task = await insertTaskFixture(project.id);
  const before = await workspaceProjects(workspaceId);
  const response = await deleteTaskInWorkspace(workspaceId, project.id, task.id, otherToken);
  expect(response.status).toBe(role === "viewer" ? 403 : 404);
  expect((await response.json()).error.code).toBe(role === "viewer" ? "FORBIDDEN" : "NOT_FOUND");
  expect(await savedProjectTasks(project.id)).toEqual([task]);
  expect(await workspaceProjects(workspaceId)).toEqual(before);
});

test("task deletion requires authentication before validating IDs", async () => {
  const response = await deleteTaskInWorkspace("invalid", "invalid", "invalid");
  expect(response.status).toBe(401);
  await response.text();
});

test("task deletion rejects mismatched hierarchy and missing resources", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const sibling = await projectFixtureForHttp(workspaceId, ownerToken);
  const task = await insertTaskFixture(project.id);
  const created = await create({ name: "Other task deletion team" }, ownerToken);
  expect(created.status).toBe(201);
  const { data: other } = await created.json();
  const otherProject = await projectFixtureForHttp(other.id, ownerToken);
  const before = await workspaceProjects(workspaceId);
  for (const table of ["workspaces", "projects", "tasks"]) {
    expect((await pool!.query(`SELECT id FROM ${table} WHERE id = 2147483647`)).rows).toEqual([]);
  }
  for (const [wid, pid, tid] of [
    [workspaceId, sibling.id, task.id], [other.id, project.id, task.id],
    [workspaceId, otherProject.id, task.id], [2147483647, project.id, task.id],
    [workspaceId, 2147483647, task.id], [workspaceId, project.id, 2147483647],
  ]) {
    const response = await deleteTaskInWorkspace(wid, pid, tid, ownerToken);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  }
  expect(await savedProjectTasks(project.id)).toEqual([task]);
  expect(await workspaceProjects(workspaceId)).toEqual(before);
});

test("task deletion validates all three route IDs without changing records", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const task = await insertTaskFixture(project.id);
  const before = await workspaceProjects(workspaceId);
  for (const invalid of ["abc", "0", "-1", "1.5", "2147483648"]) {
    for (const field of ["wid", "pid", "tid"]) {
      const response = await deleteTaskInWorkspace(
        field === "wid" ? invalid : workspaceId,
        field === "pid" ? invalid : project.id,
        field === "tid" ? invalid : task.id,
        ownerToken,
      );
      expect(response.status).toBe(422);
      expect((await response.json()).errors).toEqual(expect.arrayContaining([expect.objectContaining({ field })]));
    }
  }
  expect(await savedProjectTasks(project.id)).toEqual([task]);
  expect(await workspaceProjects(workspaceId)).toEqual(before);
});

test("a failed cache-version update rolls back task deletion", async () => {
  const { workspaceId, ownerToken } = await ownershipFixture();
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const task = await insertTaskFixture(project.id);
  const before = await workspaceProjects(workspaceId);
  const constraint = `task_delete_failure_${randomUUID().replace(/-/g, "")}`;
  try {
    // Force the deletion trigger to fail after DELETE, proving both changes roll back.
    await pool!.query(`ALTER TABLE projects ADD CONSTRAINT ${constraint} CHECK (id <> ${project.id} OR task_cache_version <= ${BigInt(before[0].task_cache_version)}) NOT VALID`);
    const response = await deleteTaskInWorkspace(workspaceId, project.id, task.id, ownerToken);
    expect(response.status).toBe(500);
    await response.json();
    expect(await savedProjectTasks(project.id)).toEqual([task]);
    expect(await workspaceProjects(workspaceId)).toEqual(before);
  } finally {
    await pool!.query(`ALTER TABLE projects DROP CONSTRAINT IF EXISTS ${constraint}`);
  }
});

test.each(["demoted", "removed"])("a waiting task deletion rechecks permission after its editor is %s", async (change) => {
  const { workspaceId, ownerToken, otherToken } = await ownershipFixture("editor");
  const project = await projectFixtureForHttp(workspaceId, ownerToken);
  const task = await insertTaskFixture(project.id);
  const before = await workspaceProjects(workspaceId);
  const locker = await pool!.connect();
  let pending: Promise<Response> | undefined;
  try {
    await locker.query("BEGIN");
    const pid = await locker.query("SELECT pg_backend_pid() AS pid");
    await locker.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [workspaceId]);
    pending = deleteTaskInWorkspace(workspaceId, project.id, task.id, otherToken);
    void pending.catch(() => {});
    await waitForDatabaseBlocker(pid.rows[0].pid);
    await locker.query(
      change === "demoted" ? "UPDATE workspace_members SET role = 'viewer' WHERE workspace_id = $1 AND user_id = $2"
        : "DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userIds[1]],
    );
    await locker.query("COMMIT");
    const response = await pending;
    expect(response.status).toBe(change === "demoted" ? 403 : 404);
    expect((await response.json()).error.code).toBe(change === "demoted" ? "FORBIDDEN" : "NOT_FOUND");
    expect(await savedProjectTasks(project.id)).toEqual([task]);
    expect(await workspaceProjects(workspaceId)).toEqual(before);
  } finally {
    try { await locker.query("ROLLBACK"); } finally { locker.release(); }
    if (pending) await pending.then((response) => response.text()).catch(() => {});
  }
});

test("lists only the authenticated user's workspaces", async () => {
  const token = await login();

  await create({ name: "Visible workspace" }, token);

  const hiddenWorkspace = await pool!.query(
    "INSERT INTO workspaces (name, created_by) VALUES ($1, $2) RETURNING id",
    ["Hidden workspace", userIds[1]],
  );

  await pool!.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)",
    [hiddenWorkspace.rows[0].id, userIds[1], "owner"],
  );

  const response = await list(token);
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body).toEqual({
    data: [
      expect.objectContaining({
        name: "Visible workspace",
        role: "owner",
      }),
    ],
    page: { nextCursor: null },
  });
});

test("returns workspaces in pages of 20", async () => {
  const token = await login();

  for (let index = 1; index <= 21; index += 1) {
    const workspace = await pool!.query(
      "INSERT INTO workspaces (name, created_by) VALUES ($1, $2) RETURNING id",
      [`Workspace ${index}`, userIds[0]],
    );

    await pool!.query(
      "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)",
      [workspace.rows[0].id, userIds[0], "owner"],
    );
  }

  const firstResponse = await list(token);
  const firstPage = await firstResponse.json();

  expect(firstResponse.status).toBe(200);
  expect(firstPage.data).toHaveLength(20);
  expect(firstPage.page.nextCursor).toEqual(expect.any(Number));

  const secondResponse = await list(token, firstPage.page.nextCursor);
  const secondPage = await secondResponse.json();

  expect(secondResponse.status).toBe(200);
  expect(secondPage.data).toHaveLength(1);
  expect(secondPage.page.nextCursor).toBeNull();
});

test("rejects invalid afterIds", async () => {
  const token = await login();

  for (const afterId of ["not-a-number", "-1", "1.5"]) {
    const response = await fetch(
      `${baseUrl}/workspaces?afterId=${afterId}`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      },
    );

    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "afterId" }),
      ]),
    );
  }
});

test("authentication runs before name validation and prevents creation", async () => {
  const response = await create({});
  await response.text();
  expect(response.status).toBe(401);
  await expectNoWorkspace();
});

test.each([
  { label: "empty", name: "" },
  { label: "whitespace-only", name: "   " },
  { label: "over 100 characters", name: "x".repeat(101) },
  { label: "non-string", name: 123 },
  { label: "missing", name: undefined },
])("rejects a $label workspace name without creating records", async ({ name }) => {
  const response = await create({ name }, await login());
  const body = await response.json();
  expect(response.status).toBe(422);
  expect(body.requestId).toBe(response.headers.get("x-request-id"));
  expect(body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ field: "name" })]));
  await expectNoWorkspace();
});

test("membership failure rolls back the workspace insert", async () => {
  const token = await login();
  const constraint = `workspace_creation_failure_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  try {
    // Reject only this fixture account's owner insert, on the test database.
    await pool!.query(
      `ALTER TABLE workspace_members ADD CONSTRAINT ${constraint} CHECK (user_id <> ${userIds[0]} OR role <> 'owner') NOT VALID`,
    );
    const response = await create({ name: "Rollback workspace" }, token);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      message: "Internal server error",
      requestId: response.headers.get("x-request-id"),
    });
    await expectNoWorkspace();
  } finally {
    await pool!.query(`ALTER TABLE workspace_members DROP CONSTRAINT IF EXISTS ${constraint}`);
  }
});
