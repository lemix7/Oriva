import { afterAll, beforeAll, expect, jest, test } from "@jest/globals";
import type { Request, Response } from "express";
import { generateRefreshToken, hashRefreshToken } from "../shared/refresh-token.ts";

const originalOrigin = process.env.APP_ORIGIN;
const originalMode = process.env.NODE_ENV;
let cookies: typeof import("../auth/refresh-cookie.ts");
let requireTrustedOrigin: typeof import("../middleware/trusted-origin.ts").requireTrustedOrigin;

beforeAll(async () => {
  process.env.APP_ORIGIN = "https://app.example.com";
  process.env.NODE_ENV = "test";
  cookies = await import("../auth/refresh-cookie.ts");
  ({ requireTrustedOrigin } = await import("../middleware/trusted-origin.ts"));
});
afterAll(() => {
  if (originalOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = originalOrigin;
  if (originalMode === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalMode;
});

function response() {
  return { set: jest.fn().mockReturnThis(), cookie: jest.fn().mockReturnThis(), clearCookie: jest.fn().mockReturnThis() };
}

test("refresh tokens contain 32 random bytes and only their hashes are suitable for storage", () => {
  const values = Array.from({ length: 32 }, generateRefreshToken);
  expect(new Set(values.map(value => value.token)).size).toBe(32);
  for (const value of values) {
    expect(value.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(value.token, "base64url")).toHaveLength(32);
    expect(value.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(value.tokenHash).not.toBe(value.token);
    expect(hashRefreshToken(value.token)).toBe(value.tokenHash);
  }
});

test("development cookies are HttpOnly, host-only and Lax with the supplied expiry", () => {
  const res = response();
  const expires = new Date("2030-01-01");
  cookies.setRefreshCookie(res as unknown as Response, "test-only-token", expires);
  expect(res.set).toHaveBeenCalledWith("Cache-Control", "no-store");
  expect(res.cookie).toHaveBeenCalledWith("oriva_refresh", "test-only-token", {
    httpOnly: true, secure: false, sameSite: "lax", path: "/", expires,
  });
});

test.each([undefined, null, 123, {}, []])("non-string cookie values are ignored: %j", value => {
  expect(cookies.readRefreshCookie({ cookies: { oriva_refresh: value } } as unknown as Request)).toBeUndefined();
});

test("cookie reading returns the original token and clearing uses matching scope", () => {
  expect(cookies.readRefreshCookie({ cookies: { oriva_refresh: "test-only-token" } } as unknown as Request)).toBe("test-only-token");
  const res = response();
  cookies.clearRefreshCookie(res as unknown as Response);
  expect(res.clearCookie).toHaveBeenCalledWith("oriva_refresh", { httpOnly: true, secure: false, sameSite: "lax", path: "/" });
});

test("the trusted origin is accepted and responses are not cached", () => {
  const res = response();
  const next = jest.fn();
  requireTrustedOrigin({ get: () => "https://app.example.com" } as unknown as Request, res as unknown as Response, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(res.set).toHaveBeenCalledWith("Cache-Control", "no-store");
});

test.each([undefined, "null", "https://evil.example", "https://app.example.com.evil.example", "http://app.example.com", "https://sub.app.example.com", "https://app.example.com:444"])("untrusted or missing origins are rejected: %s", origin => {
  const next = jest.fn();
  expect(() => requireTrustedOrigin({ get: () => origin } as unknown as Request, response() as unknown as Response, next))
    .toThrow(expect.objectContaining({ statusCode: 403, code: "UNTRUSTED_ORIGIN" }));
  expect(next).not.toHaveBeenCalled();
});

test("production cookies use a Secure host prefix and matching deletion attributes", async () => {
  process.env.NODE_ENV = "production";
  jest.resetModules();
  const productionCookies = await import("../auth/refresh-cookie.ts");
  const res = response();
  const expires = new Date("2030-01-01");
  productionCookies.setRefreshCookie(res as unknown as Response, "test-only-token", expires);
  expect(res.cookie).toHaveBeenCalledWith("__Host-oriva_refresh", "test-only-token", {
    httpOnly: true, secure: true, sameSite: "lax", path: "/", expires,
  });
  productionCookies.clearRefreshCookie(res as unknown as Response);
  expect(res.clearCookie).toHaveBeenCalledWith("__Host-oriva_refresh", { httpOnly: true, secure: true, sameSite: "lax", path: "/" });
});
