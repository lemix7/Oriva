import { beforeEach, expect, jest, test } from "@jest/globals";
import { hashRefreshToken } from "../shared/refresh-token.ts";

const lockAuthUser = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const findRefreshSessionByHash = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const lockRefreshSession = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const insertRefreshSession = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const markRefreshSessionRotated = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const revokeRefreshFamily = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const createAccessToken = jest.fn<(...args: unknown[]) => string>();
const tx = {};
const events: string[] = [];
const transaction = jest.fn<(callback: (tx: object) => Promise<unknown>) => Promise<unknown>>();
jest.unstable_mockModule("../db/index.js", () => ({ db: { transaction } }));
jest.unstable_mockModule("../auth/access-token.js", () => ({ createAccessToken }));
jest.unstable_mockModule("../repositories/refresh-session.repository.js", () => ({ lockAuthUser, findRefreshSessionByHash, lockRefreshSession, insertRefreshSession, markRefreshSessionRotated, revokeRefreshFamily }));
const { createLoginSession, rotateRefreshSession, logoutSession } = await import("../services/auth-session.service.ts");
let session: { id: number; userId: number; familyId: string; expiresAt: Date; rotatedAt: Date | null; revokedAt: Date | null };

beforeEach(() => {
  for (const mock of [lockAuthUser, findRefreshSessionByHash, lockRefreshSession, insertRefreshSession, markRefreshSessionRotated, revokeRefreshFamily]) mock.mockReset();
  session = { id: 10, userId: 42, familyId: "test-family", expiresAt: new Date(Date.now() + 60000), rotatedAt: null, revokedAt: null };
  events.length = 0;
  transaction.mockReset().mockImplementation(async callback => {
    events.push("begin");
    try { const result = await callback(tx); events.push("commit"); return result; }
    catch (error) { events.push("rollback"); throw error; }
  });
  lockAuthUser.mockResolvedValue({ id: 42, password: "verified-hash" });
  findRefreshSessionByHash.mockImplementation(async () => session);
  lockRefreshSession.mockImplementation(async () => session);
  markRefreshSessionRotated.mockResolvedValue({ id: 10 });
  insertRefreshSession.mockImplementation(async (_tx, input) => ({ ...session, ...(input as object), id: 11 }));
  createAccessToken.mockReset().mockReturnValue("test-access-token");
});

test("login stores a hash and sets a seven-day session after checking the locked password", async () => {
  const start = Date.now();
  const tokens = await createLoginSession(42, "verified-hash");
  const input = insertRefreshSession.mock.calls[0][1] as { userId: number; tokenHash: string; expiresAt: Date; familyId?: string };
  expect(input.userId).toBe(42);
  expect(input.tokenHash).toBe(hashRefreshToken(tokens.refreshToken));
  expect(input.familyId).toBeUndefined();
  expect(input.expiresAt.getTime()).toBeGreaterThanOrEqual(start + 7 * 86400000);
  expect(input.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 7 * 86400000);
  expect(lockAuthUser).toHaveBeenCalledWith(tx, 42);
  expect(events).toEqual(["begin", "commit"]);
});

test.each([null, { id: 42, password: "changed-hash" }])("login rejects deleted users or changed credentials: %j", async user => {
  lockAuthUser.mockResolvedValue(user);
  await expect(createLoginSession(42, "verified-hash")).rejects.toMatchObject({ statusCode: 401, code: "INVALID_CREDENTIALS" });
  expect(insertRefreshSession).not.toHaveBeenCalled();
  expect(events).toEqual(["begin", "rollback"]);
});

test("signing failure rolls back session creation", async () => {
  createAccessToken.mockImplementation(() => { throw new Error("Signing failed"); });
  await expect(createLoginSession(42, "verified-hash")).rejects.toThrow("Signing failed");
  expect(events).toEqual(["begin", "rollback"]);
});

test("rotation locks the user before re-reading the session and preserves family expiry", async () => {
  const tokens = await rotateRefreshSession("original-token");
  expect(findRefreshSessionByHash).toHaveBeenCalledWith(hashRefreshToken("original-token"));
  expect(lockAuthUser).toHaveBeenCalledWith(tx, 42);
  expect(lockRefreshSession).toHaveBeenCalledWith(tx, hashRefreshToken("original-token"));
  expect(lockAuthUser.mock.invocationCallOrder[0]).toBeLessThan(lockRefreshSession.mock.invocationCallOrder[0]!);
  expect(insertRefreshSession).toHaveBeenCalledWith(tx, { userId: 42, familyId: session.familyId, tokenHash: hashRefreshToken(tokens.refreshToken), expiresAt: session.expiresAt });
  expect(tokens.refreshExpiresAt).toEqual(session.expiresAt);
  expect(revokeRefreshFamily).not.toHaveBeenCalled();
});

test("unknown refresh tokens are rejected without starting a transaction", async () => {
  findRefreshSessionByHash.mockResolvedValue(null);
  await expect(rotateRefreshSession("unknown-token")).rejects.toMatchObject({ statusCode: 401, code: "INVALID_REFRESH_TOKEN" });
  expect(transaction).not.toHaveBeenCalled();
});

test.each(["user", "session", "ownership", "expired", "revoked", "rotation"])("locked refresh validation rejects %s failures without inserting a successor", async reason => {
  if (reason === "user") lockAuthUser.mockResolvedValue(null);
  if (reason === "session") lockRefreshSession.mockResolvedValue(null);
  if (reason === "ownership") session.userId = 99;
  if (reason === "expired") session.expiresAt = new Date(0);
  if (reason === "revoked") session.revokedAt = new Date();
  if (reason === "rotation") markRefreshSessionRotated.mockResolvedValue(null);
  await expect(rotateRefreshSession("original-token")).rejects.toMatchObject({ statusCode: 401, code: "INVALID_REFRESH_TOKEN" });
  expect(insertRefreshSession).not.toHaveBeenCalled();
});

test("reuse revocation commits before the authentication error is thrown", async () => {
  session.rotatedAt = new Date();
  await expect(rotateRefreshSession("original-token")).rejects.toMatchObject({ statusCode: 401, code: "REFRESH_TOKEN_REUSED" });
  expect(revokeRefreshFamily).toHaveBeenCalledWith(tx, 42, session.familyId, expect.any(Date));
  expect(events).toEqual(["begin", "commit"]);
  expect(insertRefreshSession).not.toHaveBeenCalled();
});

test("a failed family revocation propagates the database failure rather than claiming a saved revocation", async () => {
  session.rotatedAt = new Date();
  const error = new Error("Revocation write failed");
  revokeRefreshFamily.mockRejectedValue(error);
  await expect(rotateRefreshSession("original-token")).rejects.toBe(error);
  expect(events).toEqual(["begin", "rollback"]);
});

test.each(["insertion", "signing"])("failed successor %s rolls back rotation", async stage => {
  if (stage === "insertion") insertRefreshSession.mockRejectedValue(new Error("Successor failed"));
  else createAccessToken.mockImplementation(() => { throw new Error("Successor failed"); });
  await expect(rotateRefreshSession("original-token")).rejects.toThrow("Successor failed");
  expect(events).toEqual(["begin", "rollback"]);
});

test.each([undefined, "unknown-token"])("logout is idempotent for absent or unknown tokens: %s", async token => {
  findRefreshSessionByHash.mockResolvedValue(null);
  await expect(logoutSession(token)).resolves.toBeUndefined();
  expect(transaction).not.toHaveBeenCalled();
});

test("logout locks the user then session and revokes only that login family", async () => {
  await logoutSession("original-token");
  expect(lockAuthUser.mock.invocationCallOrder[0]).toBeLessThan(lockRefreshSession.mock.invocationCallOrder[0]!);
  expect(revokeRefreshFamily).toHaveBeenCalledWith(tx, 42, session.familyId, expect.any(Date));
  expect(events).toEqual(["begin", "commit"]);
});
