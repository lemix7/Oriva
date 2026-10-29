import { afterAll, afterEach, beforeAll, beforeEach, expect, jest, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

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

async function login(): Promise<string> {
  const response = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ownerEmail, password }),
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

async function expectNoWorkspace() {
  const result = await pool!.query(
    "SELECT count(*)::int AS count FROM workspaces WHERE created_by = ANY($1::int[])",
    [userIds],
  );
  expect(result.rows[0].count).toBe(0);
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
