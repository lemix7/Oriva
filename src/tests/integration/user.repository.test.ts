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

test("user creation persists the registration fields and supports login lookup", async () => {
  const user = await insertFixture();
  const previous = await pool!.query("SELECT * FROM users WHERE id = $1", [user.id]);
  expect(user).toEqual(previous.rows[0]);
  expect(user).toMatchObject({ role: "user", profile_pic_key: "avatars/test.png" });
  expect(await repository.findUserByEmail(user.email!)).toEqual({
    id: user.id,
    password: user.password,
  });
  expect(await repository.findUserByEmail("missing-user@test.local")).toBeNull();
});

test("profile lookup returns only safe fields for the requested account", async () => {
  const user = await insertFixture();
  const other = await insertFixture();
  expect(await repository.findUserProfileById(user.id)).toEqual({
    id: user.id, name: user.name, email: user.email,
  });
  expect(await repository.findUserProfileById(other.id)).toEqual({
    id: other.id, name: other.name, email: other.email,
  });
});

test("profile lookup returns undefined for missing and deleted accounts", async () => {
  expect(await repository.findUserProfileById(-1)).toBeUndefined();
  const user = await insertFixture();
  await pool!.query("DELETE FROM users WHERE id = $1", [user.id]);
  expect(await repository.findUserProfileById(user.id)).toBeUndefined();
});

test("profile lookup preserves nullable profile fields", async () => {
  const user = await insertFixture();
  await pool!.query("UPDATE users SET name = NULL, email = NULL WHERE id = $1", [user.id]);
  expect(await repository.findUserProfileById(user.id)).toEqual({
    id: user.id, name: null, email: null,
  });
});

test("profile updates persist safe fields only and leave other accounts unchanged", async () => {
  const user = await insertFixture();
  const other = await insertFixture();
  const changes = { name: "Updated profile", email: `${randomUUID().replace(/-/g, "").slice(0, 16)}@test.local`, password: "ignored", role: "owner", id: other.id, profilePicKey: "ignored" };
  expect(await repository.updateUserProfile(user.id, changes)).toEqual({ id: user.id, name: changes.name, email: changes.email });
  const saved = await pool!.query("SELECT * FROM users WHERE id = $1", [user.id]);
  const savedOther = await pool!.query("SELECT * FROM users WHERE id = $1", [other.id]);
  expect(saved.rows).toEqual([{ ...user, name: changes.name, email: changes.email }]);
  expect(savedOther.rows).toEqual([other]);
});

test("partial profile updates preserve omitted fields", async () => {
  const user = await insertFixture();
  expect(await repository.updateUserProfile(user.id, { name: "New profile name" })).toEqual({ id: user.id, name: "New profile name", email: user.email });
  const email = `${randomUUID().replace(/-/g, "").slice(0, 16)}@test.local`;
  expect(await repository.updateUserProfile(user.id, { email })).toEqual({ id: user.id, name: "New profile name", email });
});

test("profile updates report no result for missing and deleted accounts", async () => {
  expect(await repository.updateUserProfile(-1, { name: "New profile name" })).toBeUndefined();
  const user = await insertFixture();
  await pool!.query("DELETE FROM users WHERE id = $1", [user.id]);
  expect(await repository.updateUserProfile(user.id, { name: "New profile name" })).toBeUndefined();
});

test("failed profile updates preserve both fields", async () => {
  const user = await insertFixture();
  await expect(repository.updateUserProfile(user.id, { name: "New profile name", email: "x".repeat(31) })).rejects.toThrow();
  const saved = await pool!.query("SELECT * FROM users WHERE id = $1", [user.id]);
  expect(saved.rows).toEqual([user]);
});

test("the email index rejects case and whitespace variants during registration", async () => {
  const user = await insertFixture();
  await expect(repository.insertUser("Duplicate account", ` ${user.email!.toUpperCase()} `, "test-only-hash", null))
    .rejects.toMatchObject({ cause: { code: "23505", constraint: "users_email_unique" } });
  const rows = await pool!.query("SELECT id FROM users WHERE lower(trim(email)) = $1", [user.email]);
  expect(rows.rows).toEqual([{ id: user.id }]);
});

test("a duplicate-email profile edit rolls back every requested change", async () => {
  const user = await insertFixture();
  const other = await insertFixture();
  const before = await pool!.query("SELECT * FROM users WHERE id = ANY($1::int[]) ORDER BY id", [[user.id, other.id]]);
  await expect(repository.updateUserProfile(user.id, { name: "Rejected name", email: ` ${other.email!.toUpperCase()} ` }))
    .rejects.toMatchObject({ cause: { code: "23505", constraint: "users_email_unique" } });
  const after = await pool!.query("SELECT * FROM users WHERE id = ANY($1::int[]) ORDER BY id", [[user.id, other.id]]);
  expect(after.rows).toEqual(before.rows);
});

test("a user can retain their own email while changing their name", async () => {
  const user = await insertFixture();
  expect(await repository.updateUserProfile(user.id, { name: "Same email owner", email: user.email! }))
    .toEqual({ id: user.id, name: "Same email owner", email: user.email });
});

test("the migration normalizes existing emails before enforcing uniqueness", async () => {
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    // Shadow users only on this connection; the real migration never touches public users.
    await client.query("CREATE TEMP TABLE users (email varchar(30)) ON COMMIT DROP");
    await client.query("INSERT INTO users VALUES ('  Alice@Example.COM  '), ('BOB@example.com'), (NULL)");
    await client.query(readFileSync("drizzle/0006_unique-user-email.sql", "utf8"));
    expect((await client.query("SELECT email FROM users ORDER BY email NULLS LAST")).rows)
      .toEqual([{ email: "alice@example.com" }, { email: "bob@example.com" }, { email: null }]);
    await expect(client.query("INSERT INTO users VALUES (' ALICE@EXAMPLE.COM ')"))
      .rejects.toMatchObject({ code: "23505", constraint: "users_email_unique" });
  } finally {
    try { await client.query("ROLLBACK"); } finally { client.release(); }
  }
});
