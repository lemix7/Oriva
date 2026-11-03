import { afterAll, afterEach, beforeAll, beforeEach, expect, jest, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

// These services are outside the login/project-read flow. Importing the app
// must not connect to Redis, start a worker, or create an AWS client here.
const addEmailJob = jest.fn();
const uploadProfilePicture = jest.fn();
const deleteProfilePicture = jest.fn();
jest.unstable_mockModule("../../queue/email.que.js", () => ({
  default: { add: addEmailJob },
}));
jest.unstable_mockModule("../../adapters/profile-pic-storage.adapter.js", () => ({
  uploadProfilePicture,
  deleteProfilePicture,
}));

let pool: Pool | undefined;
let server: Server | undefined;
let baseUrl: string;
let passwordHash: string;
let userAEmail: string;
let userBEmail: string;
let userBId: number;
let projectId: number;
let taskId: number;
const password = "test-password";
const userIds: number[] = [];
const projectIds: number[] = [];
const workspaceIds: number[] = [];
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalAppOrigin = process.env.APP_ORIGIN;
const testAppOrigin = "http://localhost:5173";
const originalSecret = process.env.SECRET_KEY;

beforeAll(async () => {
  const config = dotenv.parse(readFileSync(".env.test"));
  const testDatabaseUrl = process.env.TEST_DATABASE_URL || config.TEST_DATABASE_URL;
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required in .env.test");
  const url = new URL(testDatabaseUrl);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    decodeURIComponent(url.pathname.slice(1)) !== "oriva_test"
  ) {
    throw new Error("End-to-end tests require the local oriva_test database");
  }

  // Real login and verification share this test-only secret. Set it and the
  // test connection before any application modules read their environment.
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.APP_ORIGIN = testAppOrigin;
  process.env.SECRET_KEY = "e2e-only-secret-for-project-ownership";
  ({ default: pool } = await import("../../pool/pooler.ts"));
  const result = await pool.query("SELECT current_database() AS database");
  expect(result.rows[0].database).toBe("oriva_test");

  passwordHash = await bcrypt.hash(password, 8);
  const { default: app } = await import("../../app.ts");
  await new Promise<void>((resolve, reject) => {
    // Port 0 asks the OS for an available port rather than using port 4000.
    server = app.listen(0, "127.0.0.1", error => error ? reject(error) : resolve());
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  userAEmail = `${randomUUID().replace(/-/g, "").slice(0, 16)}@test.local`;
  userBEmail = `${randomUUID().replace(/-/g, "").slice(0, 16)}@test.local`;
  for (const [name, email] of [["HTTP user A", userAEmail], ["HTTP user B", userBEmail]]) {
    const result = await pool!.query(
      "INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id",
      [name, email, passwordHash],
    );
    userIds.push(result.rows[0].id);
  }
  userBId = userIds[1]!;
  const workspace = await pool!.query(
    "INSERT INTO workspaces (name, created_by) VALUES ('Retired-route fixture', $1) RETURNING id",
    [userBId],
  );
  workspaceIds.push(workspace.rows[0].id);
  const result = await pool!.query(
    "INSERT INTO projects (name, description, status, user_id, workspace_id) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    ["HTTP ownership project", "Owned by B", "active", userBId, workspace.rows[0].id],
  );
  projectId = result.rows[0].id;
  projectIds.push(projectId);
  const task = await pool!.query(
    "INSERT INTO tasks (project_id, title) VALUES ($1, 'Retired-route task') RETURNING id",
    [projectId],
  );
  taskId = task.rows[0].id;
});

afterEach(async () => {
  if (!pool) return;
  if (projectIds.length) {
    await pool.query("DELETE FROM tasks WHERE project_id = ANY($1::int[])", [projectIds]);
    await pool.query("DELETE FROM projects WHERE id = ANY($1::int[])", [projectIds]);
    projectIds.length = 0;
  }
  if (workspaceIds.length) {
    await pool.query("DELETE FROM workspaces WHERE id = ANY($1::int[])", [workspaceIds]);
    workspaceIds.length = 0;
  }
  if (userIds.length) {
    await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [userIds]);
    userIds.length = 0;
  }
});

afterAll(async () => {
  try {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server!.close(error => error ? reject(error) : resolve());
      });
    }
  } finally {
    try {
      await pool?.end();
    } finally {
      if (originalAppOrigin === undefined) delete process.env.APP_ORIGIN;
      else process.env.APP_ORIGIN = originalAppOrigin;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
      if (originalSecret === undefined) delete process.env.SECRET_KEY;
      else process.env.SECRET_KEY = originalSecret;
    }
  }
});

async function loginAs(email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { origin: testAppOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(5000),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { token: string };
  expect(body.token).toEqual(expect.any(String));
  expect(body.token.length).toBeGreaterThan(0);
  return body.token;
}

test("retired user, project, and task routes return 404 without changing records", async () => {
  const usersBefore = await pool!.query("SELECT * FROM users WHERE id = ANY($1::int[]) ORDER BY id", [userIds]);
  const projectBefore = await pool!.query("SELECT * FROM projects WHERE id = $1", [projectId]);
  const taskBefore = await pool!.query("SELECT * FROM tasks WHERE id = $1", [taskId]);
  const routes = [
    ["GET", "/users"],
    ["GET", `/users/${userBId}`],
    ["PUT", `/users/${userBId}`],
    ["PATCH", `/users/${userBId}`],
    ["DELETE", `/users/${userBId}`],
    ["GET", "/users/projects"],
    ["POST", "/users/projects"],
    ["GET", `/users/projects/${projectId}`],
    ["PATCH", `/users/projects/${projectId}`],
    ["DELETE", `/users/projects/${projectId}`],
    ["POST", `/users/projects/1/projects`],
    ["GET", `/projects/${projectId}/tasks`],
    ["POST", `/projects/${projectId}/tasks`],
    ["GET", `/projects/${projectId}/tasks/${taskId}`],
    ["PATCH", `/projects/${projectId}/tasks/${taskId}`],
    ["DELETE", `/projects/${projectId}/tasks/${taskId}`],
  ] as const;

  for (const email of [userAEmail, userBEmail]) {
    const token = await loginAs(email);
    for (const [method, path] of routes) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(method === "POST" || method === "PATCH" || method === "PUT"
          ? { body: JSON.stringify({ name: "Unexpected project", title: "Unexpected task", status: "active" }) }
          : {}),
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: {
        code: "NOT_FOUND", message: "Route not found",
        requestId: response.headers.get("x-request-id"),
      } });
    }
  }

  expect((await pool!.query("SELECT * FROM projects WHERE id = $1", [projectId])).rows).toEqual(projectBefore.rows);
  expect((await pool!.query("SELECT * FROM tasks WHERE id = $1", [taskId])).rows).toEqual(taskBefore.rows);
  expect((await pool!.query("SELECT * FROM users WHERE id = ANY($1::int[]) ORDER BY id", [userIds])).rows).toEqual(usersBefore.rows);
  expect((await pool!.query("SELECT id FROM projects WHERE user_id = ANY($1::int[])", [userIds])).rows)
    .toEqual([{ id: projectId }]);
  expect((await pool!.query("SELECT id FROM tasks WHERE project_id = $1", [projectId])).rows)
    .toEqual([{ id: taskId }]);

  for (const dependency of [addEmailJob, uploadProfilePicture, deleteProfilePicture]) {
    expect(dependency).not.toHaveBeenCalled();
  }
});
