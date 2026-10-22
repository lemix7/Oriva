import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import type { Pool } from "pg";

let pool: Pool | undefined;
let getProjectsByUserId: typeof import("../../repositories/project.repository.ts").getProjectsByUserId;
let updateProject: typeof import("../../repositories/project.repository.ts").updateProject;
let deleteProject: typeof import("../../repositories/project.repository.ts").deleteProject;
const originalDatabaseUrl = process.env.DATABASE_URL;
const userIds: number[] = [];
const projectIds: number[] = [];
let userAId: number;
let userBId: number;
let projectId: number;

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
  ({ getProjectsByUserId, updateProject, deleteProject } = await import("../../repositories/project.repository.ts"));
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
});

afterEach(async () => {
  // Runs even after a failed assertion or partially completed beforeEach.
  // Delete only our tracked fixtures, in foreign-key dependency order.
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
    await pool?.end();
  } finally {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

test("user A cannot read user B's project", async () => {
  const project = await getProjectsByUserId(userAId, projectId);
  expect(project).toBeNull();
});

test("user B can read their own project", async () => {
  const project = await getProjectsByUserId(userBId, projectId);
  expect(project).toMatchObject({ id: projectId, user_id: userBId, name: "User B project" });
});

test("user A cannot update user B's project and its status stays active", async () => {
  // Act: try to update B's project using A's identity.
  const updatedProject = await updateProject("completed", projectId, userAId);

  // Assert: the repository reports no accessible project was updated.
  expect(updatedProject).toBeNull();

  // Check persisted state too, rather than relying only on the return value.
  const project = await getProjectsByUserId(userBId, projectId);
  expect(project).toMatchObject({
    id: projectId,
    user_id: userBId,
    status: "active",
  });
});

test("user B can update their own project and the new status is persisted", async () => {
  const updatedProject = await updateProject("completed", projectId, userBId);
  expect(updatedProject).toMatchObject({
    id: projectId,
    user_id: userBId,
    status: "completed",
  });

  // A fresh lookup confirms PostgreSQL saved the change.
  const project = await getProjectsByUserId(userBId, projectId);
  expect(project).toMatchObject({
    id: projectId,
    user_id: userBId,
    status: "completed",
  });
});

test("user A cannot delete user B's project", async () => {
  const deletedProject = await deleteProject(userAId, projectId);
  expect(deletedProject).toBeNull();

  // Verify the row still exists and belongs to B after the attempted deletion.
  const project = await getProjectsByUserId(userBId, projectId);
  expect(project).toMatchObject({
    id: projectId,
    user_id: userBId,
    name: "User B project",
    status: "active",
  });
});

test("user B can delete their own project", async () => {
  const deletedProject = await deleteProject(userBId, projectId);
  expect(deletedProject).toMatchObject({
    id: projectId,
    user_id: userBId,
    name: "User B project",
  });

  // The deleted row must no longer be available even to its original owner.
  const project = await getProjectsByUserId(userBId, projectId);
  expect(project).toBeNull();
});
