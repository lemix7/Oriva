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
