import { afterAll, afterEach, beforeAll, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import type { Pool } from "pg";

let pool: Pool | undefined;
let repository: typeof import("../../repositories/user.repository.ts");
const originalDatabaseUrl = process.env.DATABASE_URL;
const userIds: number[] = [];

beforeAll(async () => {
  const config = dotenv.parse(readFileSync(".env.test"));
  const connectionString = process.env.TEST_DATABASE_URL || config.TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TEST_DATABASE_URL is required");
  const url = new URL(connectionString);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      || decodeURIComponent(url.pathname.slice(1)) !== "oriva_test") {
    throw new Error("Integration tests require the local oriva_test database");
  }
  process.env.DATABASE_URL = connectionString;
  ({ default: pool } = await import("../../pool/pooler.ts"));
  const result = await pool.query("SELECT current_database() AS database");
  expect(result.rows[0].database).toBe("oriva_test");
  repository = await import("../../repositories/user.repository.ts");
});

afterEach(async () => {
  if (pool && userIds.length) {
    await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [userIds]);
    userIds.length = 0;
  }
});

afterAll(async () => {
  try { await pool?.end(); } finally {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

async function insertFixture() {
  const email = `${randomUUID().replace(/-/g, "").slice(0, 16)}@test.local`;
  const user = await repository.insertUser("Repository user", email, "test-only-hash", "avatars/test.png");
  userIds.push(user.id);
  return user;
}

test("user creation and reads retain the existing flat row shape", async () => {
  const user = await insertFixture();
  const previous = await pool!.query("SELECT * FROM users WHERE id = $1", [user.id]);
  expect(user).toEqual(previous.rows[0]);
  expect(user).toMatchObject({ role: "user", profile_pic_key: "avatars/test.png" });
  expect(await repository.findUsersById(user.id)).toEqual(previous.rows);
  expect(await repository.findUsersById(-1)).toEqual([]);
  expect(await repository.findUserByEmail(user.email!)).toEqual({
    id: user.id,
    password: user.password,
  });
  expect(await repository.findUserByEmail("missing-user@test.local")).toBeNull();
});

test("user listing preserves all rows ordered by ID", async () => {
  await insertFixture();
  await insertFixture();
  const previous = await pool!.query("SELECT * FROM users ORDER BY id ASC");
  expect(await repository.findAllUsers()).toEqual(previous.rows);
});

test("user update reports affected rows and persists only the requested user", async () => {
  const user = await insertFixture();
  const other = await insertFixture();
  expect(await repository.updateUser("Updated", "updated@test.local", user.id)).toBe(true);
  expect(await repository.findUsersById(user.id)).toEqual([
    { ...user, name: "Updated", email: "updated@test.local" },
  ]);
  expect(await repository.findUsersById(other.id)).toEqual([other]);
  expect(await repository.updateUser("Missing", "missing@test.local", -1)).toBe(false);
});

test("user deletion reports affected rows and leaves the other user intact", async () => {
  const user = await insertFixture();
  const other = await insertFixture();
  expect(await repository.deleteUser(user.id)).toBe(true);
  expect(await repository.findUsersById(user.id)).toEqual([]);
  expect(await repository.findUsersById(other.id)).toEqual([other]);
  expect(await repository.deleteUser(user.id)).toBe(false);
});
