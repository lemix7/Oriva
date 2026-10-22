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
const cacheGet = jest.fn();
const cacheSet = jest.fn();
jest.unstable_mockModule("../../queue/email.que.js", () => ({
  default: { add: addEmailJob },
}));
jest.unstable_mockModule("../../adapters/profile-pic-storage.adapter.js", () => ({
  uploadProfilePicture,
  deleteProfilePicture,
}));
jest.unstable_mockModule("../../config/task-cache.js", () => ({
  default: { get: cacheGet, set: cacheSet },
}));

let pool: Pool | undefined;
let server: Server | undefined;
let baseUrl: string;
let passwordHash: string;
let userAEmail: string;
let userBEmail: string;
let userBId: number;
let projectId: number;
const password = "test-password";
const userIds: number[] = [];
const projectIds: number[] = [];
const originalDatabaseUrl = process.env.DATABASE_URL;
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
  const result = await pool!.query(
    "INSERT INTO projects (name, description, status, user_id) VALUES ($1, $2, $3, $4) RETURNING id",
    ["HTTP ownership project", "Owned by B", "active", userBId],
  );
  projectId = result.rows[0].id;
  projectIds.push(projectId);
});

afterEach(async () => {
  if (!pool) return;
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
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server!.close(error => error ? reject(error) : resolve());
      });
    }
  } finally {
    try {
      await pool?.end();
    } finally {
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(5000),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { token: string };
  expect(body.token).toEqual(expect.any(String));
  expect(body.token.length).toBeGreaterThan(0);
  return body.token;
}

test("A logs in but cannot read B's project; B logs in and can read it", async () => {
  // Use real tokens obtained over HTTP, not fabricated req.user objects.
  const tokenA = await loginAs(userAEmail);
  const denied = await fetch(`${baseUrl}/users/projects/${projectId}`, {
    headers: { Authorization: `Bearer ${tokenA}` },
    signal: AbortSignal.timeout(5000),
  });
  expect(denied.status).toBe(404);
  expect(await denied.json()).toEqual({ message: "Project not found" });

  // The positive control proves the project exists and the route is working.
  const tokenB = await loginAs(userBEmail);
  const allowed = await fetch(`${baseUrl}/users/projects/${projectId}`, {
    headers: { Authorization: `Bearer ${tokenB}` },
    signal: AbortSignal.timeout(5000),
  });
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toMatchObject({
    id: projectId,
    user_id: userBId,
    name: "HTTP ownership project",
    status: "active",
  });

  for (const dependency of [addEmailJob, uploadProfilePicture, deleteProfilePicture, cacheGet, cacheSet]) {
    expect(dependency).not.toHaveBeenCalled();
  }
});
