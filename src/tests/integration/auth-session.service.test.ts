import { afterAll, afterEach, beforeAll, beforeEach, expect, jest, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import type { Pool } from "pg";
import { hashRefreshToken } from "../../shared/refresh-token.ts";
import { hashPasswordResetToken } from "../../shared/password-reset-token.ts";

const addEmailJob = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule("../../queue/email.que.js", () => ({ default: { add: addEmailJob } }));

let pool: Pool | undefined;
let service: typeof import("../../services/auth-session.service.ts");
let changePassword: typeof import("../../services/password.service.ts").changeCurrentUserPassword;
let resetService: typeof import("../../services/password-reset.service.ts");
let editProfile: typeof import("../../services/user.service.ts").editCurrentUserProfile;
const originalUrl = process.env.DATABASE_URL;
const originalSecret = process.env.SECRET_KEY;
const testSecret = "session-integration-test-secret";
let userIds: number[] = [];

beforeAll(async () => {
  const config = dotenv.parse(readFileSync(".env.test"));
  const url = new URL(process.env.TEST_DATABASE_URL || config.TEST_DATABASE_URL);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/oriva_test" || url.searchParams.has("host") || url.searchParams.has("hostaddr")) throw new Error("Session tests require local oriva_test");
  process.env.DATABASE_URL = url.href;
  process.env.SECRET_KEY = testSecret;
  ({ default: pool } = await import("../../pool/pooler.ts"));
  service = await import("../../services/auth-session.service.ts");
  ({ changeCurrentUserPassword: changePassword } = await import("../../services/password.service.ts"));
  resetService = await import("../../services/password-reset.service.ts");
  ({ editCurrentUserProfile: editProfile } = await import("../../services/user.service.ts"));
});
beforeEach(async () => {
  addEmailJob.mockReset().mockResolvedValue({});
  userIds = [];
  for (const name of ["Session owner", "Other session owner"]) {
    const email = `${randomUUID().replace(/-/g, "").slice(0, 16)}@test.local`;
    userIds.push((await pool!.query("INSERT INTO users (name,email,password) VALUES ($1,$2,'verified-hash') RETURNING id", [name, email])).rows[0].id);
  }
});
afterEach(async () => { if (pool) await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [userIds]); });
afterAll(async () => {
  try { await pool?.end(); } finally {
    if (originalUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.SECRET_KEY; else process.env.SECRET_KEY = originalSecret;
  }
});

async function rows(userId = userIds[0]) {
  return (await pool!.query("SELECT * FROM refresh_sessions WHERE user_id = $1 ORDER BY id", [userId])).rows;
}
async function login(userId = userIds[0]) { return service.createLoginSession(userId, "verified-hash"); }
async function waitForBlocker(pid: number) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if ((await pool!.query("SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))", [pid])).rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Expected authentication request to wait for the user lock");
}

test("login stores only a token hash, issues a 15-minute JWT and limits the session to seven days", async () => {
  const start = Date.now();
  const tokens = await login();
  const saved = await rows();
  expect(saved).toHaveLength(1);
  expect(saved[0].token_hash).toBe(hashRefreshToken(tokens.refreshToken));
  expect(JSON.stringify(saved)).not.toContain(tokens.refreshToken);
  expect(saved[0].expires_at.getTime()).toBeGreaterThanOrEqual(start + 7 * 86400000);
  expect(saved[0].expires_at.getTime()).toBeLessThanOrEqual(Date.now() + 7 * 86400000);
  const payload = jwt.verify(tokens.accessToken, testSecret, { algorithms: ["HS256"] }) as jwt.JwtPayload;
  expect(payload.userId).toBe(userIds[0]);
  expect(payload.exp! - payload.iat!).toBe(900);
  expect(saved[0].revoked_at).toBeNull();
  expect(saved[0].rotated_at).toBeNull();
});

test("separate logins get separate families and stale password checks cannot create a session", async () => {
  await login(); await login();
  expect(new Set((await rows()).map(row => row.family_id)).size).toBe(2);
  await pool!.query("UPDATE users SET password = 'changed-hash' WHERE id = $1", [userIds[0]]);
  await expect(login()).rejects.toMatchObject({ statusCode: 401, code: "INVALID_CREDENTIALS" });
  expect(await rows()).toHaveLength(2);
  await expect(service.createLoginSession(-1, "verified-hash")).rejects.toMatchObject({ statusCode: 401 });
});

test("rotation retains history and family expiry while issuing a different refresh credential", async () => {
  const original = await login();
  const before = (await rows())[0];
  const replacement = await service.rotateRefreshSession(original.refreshToken);
  const saved = await rows();
  expect(saved).toHaveLength(2);
  expect(saved[0].rotated_at).toBeInstanceOf(Date);
  expect(saved[1]).toMatchObject({ family_id: before.family_id, expires_at: before.expires_at, token_hash: hashRefreshToken(replacement.refreshToken), rotated_at: null, revoked_at: null });
  expect(replacement.refreshToken).not.toBe(original.refreshToken);
  expect(replacement.refreshExpiresAt).toEqual(original.refreshExpiresAt);
});

test("reusing an ancestor commits family revocation and preserves other login families", async () => {
  const original = await login();
  const other = await login();
  const replacement = await service.rotateRefreshSession(original.refreshToken);
  await expect(service.rotateRefreshSession(original.refreshToken)).rejects.toMatchObject({ statusCode: 401, code: "REFRESH_TOKEN_REUSED" });
  const saved = await rows();
  const family = saved.find(row => row.token_hash === hashRefreshToken(original.refreshToken))!.family_id;
  expect(saved.filter(row => row.family_id === family).every(row => row.revoked_at instanceof Date)).toBe(true);
  await expect(service.rotateRefreshSession(replacement.refreshToken)).rejects.toMatchObject({ statusCode: 401 });
  await expect(service.rotateRefreshSession(other.refreshToken)).resolves.toMatchObject({ accessToken: expect.any(String) });
});

test.each(["expired", "revoked"])("%s sessions cannot rotate or create successors", async state => {
  const original = await login();
  await pool!.query(state === "expired" ? "UPDATE refresh_sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1" : "UPDATE refresh_sessions SET revoked_at = now() WHERE user_id = $1", [userIds[0]]);
  const before = await rows();
  await expect(service.rotateRefreshSession(original.refreshToken)).rejects.toMatchObject({ statusCode: 401, code: "INVALID_REFRESH_TOKEN" });
  expect(await rows()).toEqual(before);
});

test("logout is idempotent and revokes only its login family", async () => {
  const first = await login(); const second = await login(); const otherUser = await login(userIds[1]);
  await service.logoutSession(first.refreshToken);
  await service.logoutSession(first.refreshToken);
  await service.logoutSession(); await service.logoutSession("unknown-token");
  await expect(service.rotateRefreshSession(first.refreshToken)).rejects.toMatchObject({ statusCode: 401 });
  await expect(service.rotateRefreshSession(second.refreshToken)).resolves.toMatchObject({ accessToken: expect.any(String) });
  await expect(service.rotateRefreshSession(otherUser.refreshToken)).resolves.toMatchObject({ accessToken: expect.any(String) });
});

test("simultaneous refreshes rotate once then revoke the compromised family", async () => {
  const original = await login();
  const results = await Promise.allSettled([service.rotateRefreshSession(original.refreshToken), service.rotateRefreshSession(original.refreshToken)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const failure = results.find(result => result.status === "rejected") as PromiseRejectedResult;
  expect(failure.reason).toMatchObject({ statusCode: 401, code: "REFRESH_TOKEN_REUSED" });
  const saved = await rows();
  expect(saved).toHaveLength(2);
  expect(saved.every(row => row.revoked_at instanceof Date)).toBe(true);
});

test("ancestor reuse racing a newer token cannot leave an active descendant", async () => {
  const original = await login();
  const current = await service.rotateRefreshSession(original.refreshToken);
  const results = await Promise.allSettled([service.rotateRefreshSession(original.refreshToken), service.rotateRefreshSession(current.refreshToken)]);
  expect(results[0]).toMatchObject({ status: "rejected", reason: { statusCode: 401, code: "REFRESH_TOKEN_REUSED" } });
  expect((await rows()).every(row => row.revoked_at instanceof Date)).toBe(true);
  if (results[1].status === "fulfilled") await expect(service.rotateRefreshSession(results[1].value.refreshToken)).rejects.toMatchObject({ statusCode: 401 });
});

test("logout racing refresh revokes all descendants", async () => {
  const original = await login();
  const results = await Promise.allSettled([service.rotateRefreshSession(original.refreshToken), service.logoutSession(original.refreshToken)]);
  expect(results[1].status).toBe("fulfilled");
  expect((await rows()).every(row => row.revoked_at instanceof Date)).toBe(true);
});

test("failed successor insertion rolls back the old token's rotation", async () => {
  const original = await login();
  const before = await rows();
  const constraint = `session_rotation_failure_${randomUUID().replace(/-/g, "")}`;
  try {
    await pool!.query(`ALTER TABLE refresh_sessions ADD CONSTRAINT ${constraint} CHECK (user_id <> ${userIds[0]} OR token_hash = '${before[0].token_hash}') NOT VALID`);
    await expect(service.rotateRefreshSession(original.refreshToken)).rejects.toMatchObject({ cause: { code: "23514" } });
    expect(await rows()).toEqual(before);
  } finally { await pool!.query(`ALTER TABLE refresh_sessions DROP CONSTRAINT IF EXISTS ${constraint}`); }
});

test("a password change committed while login waits invalidates the earlier password check", async () => {
  const locker = await pool!.connect();
  let pending: ReturnType<typeof login> | undefined;
  try {
    await locker.query("BEGIN");
    const pid = (await locker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await locker.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userIds[0]]);
    pending = login(); void pending.catch(() => {});
    await waitForBlocker(pid);
    await locker.query("UPDATE users SET password = 'new-password-hash' WHERE id = $1", [userIds[0]]);
    await locker.query("COMMIT");
    await expect(pending).rejects.toMatchObject({ statusCode: 401, code: "INVALID_CREDENTIALS" });
    expect(await rows()).toEqual([]);
  } finally {
    try { await locker.query("ROLLBACK"); } finally { locker.release(); }
    if (pending) await pending.catch(() => {});
  }
});

test("refresh rechecks expiry after waiting for the user lock", async () => {
  const original = await login();
  const locker = await pool!.connect();
  let pending: ReturnType<typeof service.rotateRefreshSession> | undefined;
  try {
    await locker.query("BEGIN");
    const pid = (await locker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await locker.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userIds[0]]);
    pending = service.rotateRefreshSession(original.refreshToken); void pending.catch(() => {});
    await waitForBlocker(pid);
    await locker.query("UPDATE refresh_sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1", [userIds[0]]);
    await locker.query("COMMIT");
    await expect(pending).rejects.toMatchObject({ statusCode: 401 });
    const saved = await rows(); expect(saved).toHaveLength(1); expect(saved[0].rotated_at).toBeNull();
  } finally {
    try { await locker.query("ROLLBACK"); } finally { locker.release(); }
    if (pending) await pending.catch(() => {});
  }
});

test("account deletion cascades to refresh history", async () => {
  const original = await login();
  await service.rotateRefreshSession(original.refreshToken);
  await pool!.query("DELETE FROM users WHERE id = $1", [userIds[0]]);
  expect(await rows()).toEqual([]);
  await expect(service.rotateRefreshSession(original.refreshToken)).rejects.toMatchObject({ statusCode: 401 });
});

test("the database rejects duplicate token hashes", async () => {
  await login();
  const before = await rows();
  await expect(pool!.query("INSERT INTO refresh_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)", [userIds[0], before[0].token_hash, before[0].expires_at]))
    .rejects.toMatchObject({ code: "23505", constraint: "refresh_sessions_token_hash_unique" });
  expect(await rows()).toEqual(before);
});

const currentPassword = "integration-test-password";

async function loginWithPassword() {
  const passwordHash = await bcrypt.hash(currentPassword, 8);
  await pool!.query("UPDATE users SET password = $1 WHERE id = $2", [passwordHash, userIds[0]]);
  return service.createLoginSession(userIds[0], passwordHash);
}

async function readPasswordHash() {
  return (await pool!.query("SELECT password FROM users WHERE id = $1", [userIds[0]])).rows[0].password as string;
}

test("a failed session revocation rolls back the password change", async () => {
  await loginWithPassword();
  const originalHash = await readPasswordHash();
  const originalSessions = await rows();
  const constraint = `password_revocation_failure_${randomUUID().replace(/-/g, "")}`;
  try {
    await pool!.query(`ALTER TABLE refresh_sessions ADD CONSTRAINT ${constraint} CHECK (user_id <> ${userIds[0]} OR revoked_at IS NULL) NOT VALID`);
    await expect(changePassword(userIds[0], currentPassword, "replacement-password"))
      .rejects.toMatchObject({ cause: { code: "23514", constraint } });
    expect(await readPasswordHash()).toBe(originalHash);
    expect(await rows()).toEqual(originalSessions);
  } finally {
    await pool!.query(`ALTER TABLE refresh_sessions DROP CONSTRAINT IF EXISTS ${constraint}`);
  }
});

test("concurrent changes using the same current password succeed only once", async () => {
  await loginWithPassword();
  const replacements = ["first-replacement", "second-replacement"];
  const results = await Promise.allSettled(
    replacements.map(replacement => changePassword(userIds[0], currentPassword, replacement)),
  );
  const winner = results.findIndex(result => result.status === "fulfilled");
  expect(winner).toBeGreaterThanOrEqual(0);
  expect(results[1 - winner]).toMatchObject({
    status: "rejected",
    reason: { statusCode: 422, code: "INVALID_CURRENT_PASSWORD" },
  });
  await expect(bcrypt.compare(replacements[winner], await readPasswordHash())).resolves.toBe(true);
});

test("refresh racing a password change leaves no active session for that account", async () => {
  const original = await loginWithPassword();
  const alreadyRevoked = await service.createLoginSession(userIds[0], await readPasswordHash());
  await service.logoutSession(alreadyRevoked.refreshToken);
  const oldRevocation = (await rows())[1].revoked_at;
  const [changed, refreshed] = await Promise.allSettled([
    changePassword(userIds[0], currentPassword, "replacement-password"),
    service.rotateRefreshSession(original.refreshToken),
  ]);
  expect(changed.status).toBe("fulfilled");
  if (refreshed.status === "rejected") {
    expect(refreshed.reason).toMatchObject({ statusCode: 401 });
  }
  const saved = await rows();
  expect(saved.every(row => row.revoked_at instanceof Date)).toBe(true);
  expect(saved[1].revoked_at).toEqual(oldRevocation);
});

async function issueReset() {
  const email = (await pool!.query("SELECT email FROM users WHERE id = $1", [userIds[0]])).rows[0].email as string;
  await resetService.requestPasswordReset(email);
  const call = addEmailJob.mock.calls[addEmailJob.mock.calls.length - 1];
  expect(call[0]).toBe("sendPasswordResetEmail");
  return (call[1] as { token: string }).token;
}

async function resetRows() {
  return (await pool!.query("SELECT * FROM password_reset_tokens WHERE user_id = $1", [userIds[0]])).rows;
}

test("requesting recovery stores only the token hash for 15 minutes and preserves sessions", async () => {
  await loginWithPassword();
  const beforePassword = await readPasswordHash();
  const beforeSessions = await rows();
  const started = Date.now();
  const token = await issueReset();
  const saved = await resetRows();
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ token_hash: hashPasswordResetToken(token), used_at: null });
  expect(saved[0].expires_at.getTime()).toBeGreaterThanOrEqual(started + 15 * 60000);
  expect(saved[0].expires_at.getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60000);
  expect(JSON.stringify(saved)).not.toContain(token);
  expect(await readPasswordHash()).toBe(beforePassword);
  expect(await rows()).toEqual(beforeSessions);
  expect(addEmailJob.mock.calls[0][2]).toEqual({ removeOnComplete: true, removeOnFail: true });
});

test("an unknown email generates no token or delivery job", async () => {
  await resetService.requestPasswordReset("unknown@test.local");
  expect(addEmailJob).not.toHaveBeenCalled();
  expect(await resetRows()).toEqual([]);
});

test("replacement links invalidate previous tokens and reset the used timestamp", async () => {
  const first = await issueReset();
  const second = await issueReset();
  expect(first).not.toBe(second);
  expect(await resetRows()).toHaveLength(1);
  await expect(resetService.resetPassword(first, "replacement-password"))
    .rejects.toMatchObject({ statusCode: 400, code: "INVALID_RESET_TOKEN" });
  await resetService.resetPassword(second, "replacement-password");
  const third = await issueReset();
  expect((await resetRows())[0]).toMatchObject({ used_at: null, token_hash: hashPasswordResetToken(third) });
});

test("reset consumes its token and revokes every account family while preserving other users", async () => {
  await loginWithPassword();
  const originalHash = await readPasswordHash();
  await service.createLoginSession(userIds[0], originalHash);
  await login(userIds[1]);
  const otherSessions = await rows(userIds[1]);
  const token = await issueReset();
  await resetService.resetPassword(token, "  replacement-password  ");
  const changedHash = await readPasswordHash();
  expect(changedHash).not.toBe(originalHash);
  await expect(bcrypt.compare("  replacement-password  ", changedHash)).resolves.toBe(true);
  await expect(bcrypt.compare("replacement-password", changedHash)).resolves.toBe(false);
  expect((await resetRows())[0].used_at).toBeInstanceOf(Date);
  expect((await rows()).every(row => row.revoked_at instanceof Date)).toBe(true);
  expect(await rows(userIds[1])).toEqual(otherSessions);
  await expect(resetService.resetPassword(token, "another-password"))
    .rejects.toMatchObject({ statusCode: 400, code: "INVALID_RESET_TOKEN" });
});

test.each(["expired", "used", "unknown"])("a %s reset token cannot change credentials or sessions", async state => {
  await loginWithPassword();
  const token = await issueReset();
  if (state === "expired") {
    await pool!.query("UPDATE password_reset_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1", [userIds[0]]);
  }
  if (state === "used") {
    await pool!.query("UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1", [userIds[0]]);
  }
  const oldHash = await readPasswordHash();
  const oldSessions = await rows();
  const oldTokens = await resetRows();
  await expect(resetService.resetPassword(state === "unknown" ? "unknown-token" : token, "replacement-password"))
    .rejects.toMatchObject({ statusCode: 400, code: "INVALID_RESET_TOKEN" });
  expect(await readPasswordHash()).toBe(oldHash);
  expect(await rows()).toEqual(oldSessions);
  expect(await resetRows()).toEqual(oldTokens);
});

test("a reset revocation failure rolls back both the password and token consumption", async () => {
  await loginWithPassword();
  const token = await issueReset();
  const oldHash = await readPasswordHash();
  const oldSessions = await rows();
  const oldTokens = await resetRows();
  const constraint = `reset_revocation_failure_${randomUUID().replace(/-/g, "")}`;
  try {
    await pool!.query(`ALTER TABLE refresh_sessions ADD CONSTRAINT ${constraint} CHECK (user_id <> ${userIds[0]} OR revoked_at IS NULL) NOT VALID`);
    await expect(resetService.resetPassword(token, "replacement-password"))
      .rejects.toMatchObject({ cause: { code: "23514" } });
    expect(await readPasswordHash()).toBe(oldHash);
    expect(await rows()).toEqual(oldSessions);
    expect(await resetRows()).toEqual(oldTokens);
  } finally {
    await pool!.query(`ALTER TABLE refresh_sessions DROP CONSTRAINT IF EXISTS ${constraint}`);
  }
  await expect(resetService.resetPassword(token, "replacement-password")).resolves.toBeUndefined();
});

test("simultaneous resets consume the token exactly once", async () => {
  const token = await issueReset();
  const results = await Promise.allSettled([
    resetService.resetPassword(token, "first-reset-password"),
    resetService.resetPassword(token, "second-reset-password"),
  ]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find(result => result.status === "rejected")).toMatchObject({
    reason: { statusCode: 400, code: "INVALID_RESET_TOKEN" },
  });
});

test("password and email changes cancel recovery, while name-only and unchanged-email edits preserve it", async () => {
  await loginWithPassword();
  let token = await issueReset();
  await editProfile(userIds[0], { name: "Renamed account" });
  const email = (await pool!.query("SELECT email FROM users WHERE id = $1", [userIds[0]])).rows[0].email;
  await editProfile(userIds[0], { email });
  expect((await resetRows())[0].used_at).toBeNull();
  await changePassword(userIds[0], currentPassword, "new-account-password");
  await expect(resetService.resetPassword(token, "replacement-password"))
    .rejects.toMatchObject({ code: "INVALID_RESET_TOKEN" });

  token = await issueReset();
  await editProfile(userIds[0], { email: `${randomUUID().slice(0, 8)}@test.local` });
  await expect(resetService.resetPassword(token, "replacement-password"))
    .rejects.toMatchObject({ code: "INVALID_RESET_TOKEN" });
});

test("a failed email update preserves the original email and recovery link", async () => {
  const token = await issueReset();
  const original = await resetRows();
  const otherEmail = (await pool!.query("SELECT email FROM users WHERE id = $1", [userIds[1]])).rows[0].email;
  await expect(editProfile(userIds[0], { email: otherEmail })).rejects.toBeDefined();
  expect(await resetRows()).toEqual(original);
  await expect(resetService.resetPassword(token, "replacement-password")).resolves.toBeUndefined();
});

test("reset rechecks the token after waiting for a concurrent replacement", async () => {
  const token = await issueReset();
  const locker = await pool!.connect();
  let pending: Promise<void> | undefined;
  try {
    await locker.query("BEGIN");
    const pid = (await locker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await locker.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userIds[0]]);
    pending = resetService.resetPassword(token, "replacement-password");
    void pending.catch(() => {});
    await waitForBlocker(pid);
    await locker.query("UPDATE password_reset_tokens SET token_hash = $1 WHERE user_id = $2", [
      hashPasswordResetToken("replacement-token"), userIds[0],
    ]);
    await locker.query("COMMIT");
    await expect(pending).rejects.toMatchObject({ code: "INVALID_RESET_TOKEN" });
    expect((await resetRows())[0].used_at).toBeNull();
  } finally {
    try { await locker.query("ROLLBACK"); } finally { locker.release(); }
    if (pending) await pending.catch(() => {});
  }
});

test("account deletion removes reset tokens and prevents later reset", async () => {
  const token = await issueReset();
  await pool!.query("DELETE FROM users WHERE id = $1", [userIds[0]]);
  expect(await resetRows()).toEqual([]);
  await expect(resetService.resetPassword(token, "replacement-password"))
    .rejects.toMatchObject({ code: "INVALID_RESET_TOKEN" });
});
