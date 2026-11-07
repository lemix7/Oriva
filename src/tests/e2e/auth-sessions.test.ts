import { afterAll, afterEach, beforeAll, beforeEach, expect, jest, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import loginRateLimit from "../../middleware/login-rate-limit.ts";
import { hashRefreshToken } from "../../shared/refresh-token.ts";

jest.unstable_mockModule("../../queue/email.que.js", () => ({ default: { add: jest.fn() } }));
jest.unstable_mockModule("../../adapters/profile-pic-storage.adapter.js", () => ({ uploadProfilePicture: jest.fn(), deleteProfilePicture: jest.fn() }));
const requestLog = jest.spyOn(console, "log").mockImplementation(() => {});
const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
const originalEnv = { DATABASE_URL: process.env.DATABASE_URL, SECRET_KEY: process.env.SECRET_KEY, APP_ORIGIN: process.env.APP_ORIGIN, NODE_ENV: process.env.NODE_ENV };
const origin = "http://localhost:5173";
const secret = "auth-session-http-test-secret";
const password = "session-http-password";
let passwordHash: string;
let pool: Pool | undefined;
let server: Server | undefined;
let baseUrl: string;
let userIds: number[] = [];
let emails: string[] = [];

beforeAll(async () => {
  const config = dotenv.parse(readFileSync(".env.test"));
  const url = new URL(process.env.TEST_DATABASE_URL || config.TEST_DATABASE_URL);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/oriva_test" || url.searchParams.has("host") || url.searchParams.has("hostaddr")) throw new Error("Session HTTP tests require local oriva_test");
  process.env.DATABASE_URL = url.href;
  process.env.SECRET_KEY = secret;
  process.env.APP_ORIGIN = origin;
  process.env.NODE_ENV = "test";
  ({ default: pool } = await import("../../pool/pooler.ts"));
  passwordHash = await bcrypt.hash(password, 8);
  const { default: app } = await import("../../app.ts");
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", error => error ? reject(error) : resolve());
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  userIds = []; emails = []; requestLog.mockClear(); errorLog.mockClear();
  loginRateLimit.resetKey("127.0.0.1");
  for (const name of ["HTTP session owner", "Other HTTP session owner"]) {
    const email = `${randomUUID().replace(/-/g, "").slice(0, 16)}@test.local`;
    emails.push(email);
    userIds.push((await pool!.query("INSERT INTO users (name,email,password) VALUES ($1,$2,$3) RETURNING id", [name, email, passwordHash])).rows[0].id);
  }
});
afterEach(async () => { if (pool) await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [userIds]); });
afterAll(async () => {
  try {
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  } finally {
    try { await pool?.end(); } finally {
      for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      requestLog.mockRestore(); errorLog.mockRestore();
    }
  }
});

async function request(path: string, options: { method?: string; body?: unknown; cookie?: string; token?: string; origin?: string | null } = {}) {
  const headers: Record<string, string> = {};
  const requestOrigin = options.origin === undefined ? origin : options.origin;
  if (requestOrigin !== null) headers.origin = requestOrigin;
  if (options.cookie) headers.cookie = options.cookie;
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}${path}`, { method: options.method ?? "POST", headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.timeout(5000) });
}
function cookieFrom(response: Response) {
  const header = response.headers.get("set-cookie");
  expect(header).toBeTruthy();
  return header!.split(";")[0];
}
function rawCookie(cookie: string) { return decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)); }
async function login(email = emails[0]) {
  const response = await request("/login", { body: { email, password } });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({ message: "Login successfull", token: expect.any(String) });
  return { response, body, token: body.token as string, cookie: cookieFrom(response) };
}
async function sessions() { return (await pool!.query("SELECT * FROM refresh_sessions WHERE user_id = ANY($1::int[]) ORDER BY id", [userIds])).rows; }

test("login sets a private refresh cookie and returns only a 15-minute access token", async () => {
  const signedIn = await login();
  const header = signedIn.response.headers.get("set-cookie")!;
  expect(header).toMatch(/HttpOnly/i); expect(header).toMatch(/SameSite=Lax/i); expect(header).toMatch(/Path=\//i); expect(header).toMatch(/Expires=/i);
  expect(signedIn.response.headers.get("cache-control")).toBe("no-store");
  const payload = jwt.verify(signedIn.token, secret, { algorithms: ["HS256"] }) as jwt.JwtPayload;
  expect(payload.userId).toBe(userIds[0]); expect(payload.exp! - payload.iat!).toBe(900);
  const rows = await sessions(); expect(rows).toHaveLength(1);
  expect(rows[0].token_hash).toBe(hashRefreshToken(rawCookie(signedIn.cookie)));
  const logs = JSON.stringify([requestLog.mock.calls, errorLog.mock.calls]);
  expect(logs).not.toContain(rawCookie(signedIn.cookie)); expect(logs).not.toContain(signedIn.token); expect(logs).not.toContain(password);
});

test.each([null, "null", "https://evil.example", "http://localhost:5173.evil.example"])("login rejects an untrusted origin before issuing credentials: %s", async requestOrigin => {
  const response = await request("/login", { origin: requestOrigin, body: { email: emails[0], password } });
  expect(response.status).toBe(403); expect((await response.json()).error.code).toBe("UNTRUSTED_ORIGIN");
  expect(response.headers.get("set-cookie")).toBeNull(); expect(await sessions()).toEqual([]);
});

test("incorrect credentials do not create cookies or sessions", async () => {
  for (const body of [{ email: emails[0], password: "wrong-password" }, { email: `ghost${randomUUID().slice(0, 8)}@test.local`, password }]) {
    const response = await request("/login", { body });
    expect(response.status).toBe(401); expect(response.headers.get("set-cookie")).toBeNull(); await response.text();
  }
  expect(await sessions()).toEqual([]);
});

test("refresh works without a valid access token and preserves absolute expiry", async () => {
  const signedIn = await login();
  const initial = (await sessions())[0];
  const expired = jwt.sign({ userId: userIds[0] }, secret, { algorithm: "HS256", expiresIn: -1 });
  const denied = await request("/me", { method: "GET", token: expired }); expect(denied.status).toBe(401); await denied.text();
  const refreshed = await request("/auth/refresh", { cookie: signedIn.cookie, token: expired });
  expect(refreshed.status).toBe(200); const body = await refreshed.json();
  expect(body).toEqual({ token: expect.any(String) }); expect(refreshed.headers.get("cache-control")).toBe("no-store");
  const replacement = cookieFrom(refreshed); expect(replacement).not.toBe(signedIn.cookie);
  const rows = await sessions(); expect(rows).toHaveLength(2); expect(rows[0].rotated_at).toBeInstanceOf(Date);
  expect(rows[1]).toMatchObject({ family_id: initial.family_id, expires_at: initial.expires_at, token_hash: hashRefreshToken(rawCookie(replacement)) });
  const profile = await request("/me", { method: "GET", token: body.token }); expect(profile.status).toBe(200); await profile.json();
});

test.each(["missing", "unknown", "json-cookie"])("invalid refresh cookies return 401 and clear the cookie: %s", async kind => {
  const cookie = kind === "missing" ? undefined : kind === "unknown" ? "oriva_refresh=unknown-token" : "oriva_refresh=j:%7B%22x%22%3A1%7D";
  const response = await request("/auth/refresh", { cookie });
  expect(response.status).toBe(401); expect((await response.json()).error.code).toBe("INVALID_REFRESH_TOKEN");
  expect(response.headers.get("set-cookie")).toMatch(/^oriva_refresh=;/);
  expect(await sessions()).toEqual([]);
});

test("a refresh token supplied only in JSON is not accepted", async () => {
  const signedIn = await login(); const before = await sessions();
  const response = await request("/auth/refresh", { body: { refreshToken: rawCookie(signedIn.cookie) } });
  expect(response.status).toBe(401); await response.json(); expect(await sessions()).toEqual(before);
});

test.each(["/auth/refresh", "/auth/logout"])("CSRF checks protect %s without changing the session", async path => {
  const signedIn = await login(); const before = await sessions();
  for (const requestOrigin of [null, "null", "https://evil.example"]) {
    const response = await request(path, { cookie: signedIn.cookie, origin: requestOrigin });
    expect(response.status).toBe(403); expect((await response.json()).error.code).toBe("UNTRUSTED_ORIGIN");
    expect(response.headers.get("set-cookie")).toBeNull();
  }
  expect(await sessions()).toEqual(before);
});

test("an HTML-form-style cross-site logout cannot revoke a session", async () => {
  const signedIn = await login(); const before = await sessions();
  const response = await fetch(`${baseUrl}/auth/logout`, { method: "POST", headers: { origin: "https://evil.example", cookie: signedIn.cookie }, body: new URLSearchParams({ action: "logout" }), signal: AbortSignal.timeout(5000) });
  expect(response.status).toBe(403); await response.json(); expect(await sessions()).toEqual(before);
});

test("GET authentication routes cannot rotate, log in or log out", async () => {
  const signedIn = await login(); const before = await sessions();
  for (const path of ["/login", "/auth/refresh", "/auth/logout"]) {
    const response = await request(path, { method: "GET", cookie: signedIn.cookie, token: signedIn.token });
    expect(response.status).toBe(404); await response.json();
  }
  expect(await sessions()).toEqual(before);
});

test("reuse revokes the entire login family while another login remains usable", async () => {
  const original = await login(); const independent = await login();
  const refreshed = await request("/auth/refresh", { cookie: original.cookie }); expect(refreshed.status).toBe(200); await refreshed.json();
  const current = cookieFrom(refreshed);
  const replay = await request("/auth/refresh", { cookie: original.cookie });
  expect(replay.status).toBe(401); expect((await replay.json()).error.code).toBe("REFRESH_TOKEN_REUSED");
  const rejected = await request("/auth/refresh", { cookie: current }); expect(rejected.status).toBe(401); await rejected.json();
  const allowed = await request("/auth/refresh", { cookie: independent.cookie }); expect(allowed.status).toBe(200); await allowed.json();
  const rows = await sessions(); const family = rows.find(row => row.token_hash === hashRefreshToken(rawCookie(original.cookie)))!.family_id;
  expect(rows.filter(row => row.family_id === family).every(row => row.revoked_at instanceof Date)).toBe(true);
});

test("concurrent refreshes succeed once, detect replay and invalidate the successor", async () => {
  const original = await login();
  const responses = await Promise.all([request("/auth/refresh", { cookie: original.cookie }), request("/auth/refresh", { cookie: original.cookie })]);
  expect(responses.map(response => response.status).sort()).toEqual([200, 401]);
  let replacement: string | undefined;
  for (const response of responses) {
    const body = await response.json();
    if (response.status === 200) replacement = cookieFrom(response);
    else expect(body.error.code).toBe("REFRESH_TOKEN_REUSED");
  }
  const saved = await sessions(); expect(saved).toHaveLength(2); expect(saved.every(row => row.revoked_at instanceof Date)).toBe(true);
  const rejected = await request("/auth/refresh", { cookie: replacement }); expect(rejected.status).toBe(401); await rejected.json();
});

test("expired and revoked refresh sessions cannot renew access", async () => {
  for (const state of ["expired", "revoked"]) {
    const signedIn = await login();
    await pool!.query(state === "expired" ? "UPDATE refresh_sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1" : "UPDATE refresh_sessions SET revoked_at = now() WHERE token_hash = $1", [hashRefreshToken(rawCookie(signedIn.cookie))]);
    const before = await sessions();
    const response = await request("/auth/refresh", { cookie: signedIn.cookie }); expect(response.status).toBe(401); await response.json();
    expect(response.headers.get("set-cookie")).toMatch(/^oriva_refresh=;/); expect(await sessions()).toEqual(before);
  }
});

test("logout clears its cookie and refresh family; issued access JWTs expire normally", async () => {
  const signedIn = await login(); const independent = await login();
  const response = await request("/auth/logout", { cookie: signedIn.cookie });
  expect(response.status).toBe(204); expect(await response.text()).toBe("");
  expect(response.headers.get("set-cookie")).toMatch(/^oriva_refresh=;/);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const denied = await request("/auth/refresh", { cookie: signedIn.cookie }); expect(denied.status).toBe(401); await denied.json();
  const allowed = await request("/auth/refresh", { cookie: independent.cookie }); expect(allowed.status).toBe(200); await allowed.json();
  const access = await request("/me", { method: "GET", token: signedIn.token }); expect(access.status).toBe(200); await access.json();
});

test.each([undefined, "oriva_refresh=unknown-token"])("logout succeeds without revealing whether a token existed: %s", async cookie => {
  const response = await request("/auth/logout", { cookie }); expect(response.status).toBe(204); expect(await response.text()).toBe("");
  expect(response.headers.get("set-cookie")).toMatch(/^oriva_refresh=;/); expect(await sessions()).toEqual([]);
});

test("wrong JWT algorithms and malformed bearer prefixes return 401", async () => {
  const wrongAlgorithm = jwt.sign({ userId: userIds[0] }, secret, { algorithm: "HS384", expiresIn: "15m" });
  const denied = await request("/me", { method: "GET", token: wrongAlgorithm }); expect(denied.status).toBe(401); await denied.text();
  const valid = await login();
  const malformed = await fetch(`${baseUrl}/me`, { headers: { authorization: `BearerX${valid.token}` }, signal: AbortSignal.timeout(5000) });
  expect(malformed.status).toBe(401); await malformed.text();
});

const newPassword = "  updated-test-password  ";

function changePassword(options: Omit<NonNullable<Parameters<typeof request>[1]>, "method"> = {}) {
  return request("/me/password", {
    method: "PATCH",
    body: { currentPassword: password, newPassword },
    ...options,
  });
}

test("changing a password updates login and revokes only the authenticated account's sessions", async () => {
  const signedIn = await login();
  const secondDevice = await login();
  const otherUser = await login(emails[1]);
  const rotated = await request("/auth/refresh", { cookie: signedIn.cookie });
  expect(rotated.status).toBe(200);
  await rotated.json();
  const replacement = cookieFrom(rotated);

  const changed = await changePassword({
    origin: null,
    token: signedIn.token,
    cookie: replacement,
    body: { currentPassword: password, newPassword, userId: userIds[1] },
  });
  expect(changed.status).toBe(204);
  expect(await changed.text()).toBe("");
  expect(changed.headers.get("set-cookie")).toMatch(/^oriva_refresh=;/);
  expect(changed.headers.get("cache-control")).toBe("no-store");

  const saved = await sessions();
  const ownSessions = saved.filter(row => row.user_id === userIds[0]);
  expect(ownSessions).toHaveLength(3);
  expect(ownSessions.every(row => row.revoked_at instanceof Date)).toBe(true);
  expect(saved.filter(row => row.user_id === userIds[1])).toEqual([
    expect.objectContaining({ revoked_at: null }),
  ]);
  for (const cookie of [signedIn.cookie, replacement, secondDevice.cookie]) {
    const denied = await request("/auth/refresh", { cookie });
    expect(denied.status).toBe(401);
    await denied.json();
  }
  const unaffected = await request("/auth/refresh", { cookie: otherUser.cookie });
  expect(unaffected.status).toBe(200);
  await unaffected.json();

  for (const rejectedPassword of [password, newPassword.trim()]) {
    const denied = await request("/login", { body: { email: emails[0], password: rejectedPassword } });
    expect(denied.status).toBe(401);
    await denied.text();
  }
  const signedInAgain = await request("/login", { body: { email: emails[0], password: newPassword } });
  expect(signedInAgain.status).toBe(200);
  await signedInAgain.json();
  await login(emails[1]);

  const profile = await request("/me", { method: "GET", token: signedIn.token });
  expect(profile.status).toBe(200);
  await profile.json();
  const logs = JSON.stringify([requestLog.mock.calls, errorLog.mock.calls]);
  expect(logs).not.toContain(password);
  expect(logs).not.toContain(newPassword);
});

test("a refresh cookie or an expired access token cannot authorize a password change", async () => {
  const signedIn = await login();
  const before = await sessions();
  const expired = jwt.sign({ userId: userIds[0] }, secret, { algorithm: "HS256", expiresIn: -1 });
  for (const token of [undefined, expired]) {
    const denied = await changePassword({ token, cookie: signedIn.cookie });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("set-cookie")).toBeNull();
    await denied.text();
  }
  expect(await sessions()).toEqual(before);
});

test.each([
  {},
  { currentPassword: password },
  { currentPassword: 12345678, newPassword },
  { currentPassword: password, newPassword: "short" },
  { currentPassword: password, newPassword: "a".repeat(73) },
])("rejects invalid password-change input without clearing the cookie", async body => {
  const signedIn = await login();
  const response = await changePassword({ token: signedIn.token, cookie: signedIn.cookie, body });
  expect(response.status).toBe(422);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(await response.json()).toMatchObject({ message: "Validation failed" });
});

test("bcrypt's password limit is enforced in UTF-8 bytes", async () => {
  const signedIn = await login();
  const tooLong = await changePassword({
    token: signedIn.token,
    body: { currentPassword: password, newPassword: "é".repeat(37) },
  });
  expect(tooLong.status).toBe(422);
  expect((await tooLong.json()).error.code).toBe("PASSWORD_TOO_LONG");
  expect(tooLong.headers.get("set-cookie")).toBeNull();

  const maxLength = await changePassword({
    token: signedIn.token,
    body: { currentPassword: password, newPassword: "é".repeat(36) },
  });
  expect(maxLength.status).toBe(204);
});

test("five wrong password attempts leave credentials intact and rate-limit only that account", async () => {
  const signedIn = await login();
  const otherUser = await login(emails[1]);
  const before = await sessions();
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await changePassword({
      token: signedIn.token,
      cookie: signedIn.cookie,
      body: { currentPassword: "wrong-password", newPassword },
    });
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("INVALID_CURRENT_PASSWORD");
    expect(response.headers.get("set-cookie")).toBeNull();
  }
  const limited = await changePassword({ token: signedIn.token });
  expect(limited.status).toBe(429);
  expect((await limited.json()).error.code).toBe("RATE_LIMITED");
  expect(limited.headers.get("set-cookie")).toBeNull();
  expect(await sessions()).toEqual(before);
  await login();
  expect((await changePassword({ token: otherUser.token })).status).toBe(204);
});
