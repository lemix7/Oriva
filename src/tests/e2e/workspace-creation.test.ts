import { afterAll, afterEach, beforeAll, beforeEach, expect, jest, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import loginRateLimit from "../../middleware/login-rate-limit.ts";

// Keep the HTTP/auth/service/database flow real, without external delivery/storage.
jest.unstable_mockModule("../../queue/email.que.js", () => ({
  default: { add: jest.fn() },
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
