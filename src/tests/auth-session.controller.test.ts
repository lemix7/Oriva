import { beforeEach, expect, jest, test } from "@jest/globals";
import type { Request, Response } from "express";
import { AppError } from "../shared/app-error.ts";

const rotateRefreshSession = jest.fn<typeof import("../services/auth-session.service.ts").rotateRefreshSession>();
const logoutSession = jest.fn<typeof import("../services/auth-session.service.ts").logoutSession>();
const readRefreshCookie = jest.fn<() => string | undefined>();
const setRefreshCookie = jest.fn();
const clearRefreshCookie = jest.fn();
jest.unstable_mockModule("../services/auth-session.service.js", () => ({ rotateRefreshSession, logoutSession }));
jest.unstable_mockModule("../auth/refresh-cookie.js", () => ({ readRefreshCookie, setRefreshCookie, clearRefreshCookie }));
const { refreshSessionController, logoutSessionController } = await import("../controllers/auth-session.controller.ts");
const tokens = { accessToken: "test-access", refreshToken: "test-refresh", refreshExpiresAt: new Date("2030-01-01") };

beforeEach(() => {
  rotateRefreshSession.mockReset().mockResolvedValue(tokens);
  logoutSession.mockReset().mockResolvedValue(undefined);
  readRefreshCookie.mockReset().mockReturnValue("original-token");
  setRefreshCookie.mockReset(); clearRefreshCookie.mockReset();
});
function response() { return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() }; }

test("refresh rotates the cookie while returning only the access token in JSON", async () => {
  const res = response();
  await refreshSessionController({ body: { refreshToken: "ignored-body-token" } } as Request, res as unknown as Response);
  expect(rotateRefreshSession).toHaveBeenCalledWith("original-token");
  expect(setRefreshCookie).toHaveBeenCalledWith(res, tokens.refreshToken, tokens.refreshExpiresAt);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ token: tokens.accessToken });
  expect(clearRefreshCookie).not.toHaveBeenCalled();
});

test("missing refresh cookies are cleared and rejected before service access", async () => {
  readRefreshCookie.mockReturnValue(undefined);
  const res = response();
  await expect(refreshSessionController({} as Request, res as unknown as Response)).rejects.toMatchObject({ statusCode: 401, code: "INVALID_REFRESH_TOKEN" });
  expect(clearRefreshCookie).toHaveBeenCalledWith(res);
  expect(rotateRefreshSession).not.toHaveBeenCalled();
});

test.each(["INVALID_REFRESH_TOKEN", "REFRESH_TOKEN_REUSED"])("authentication failures clear the browser cookie: %s", async code => {
  const error = new AppError(401, code, "Please sign in again");
  rotateRefreshSession.mockRejectedValue(error);
  const res = response();
  await expect(refreshSessionController({} as Request, res as unknown as Response)).rejects.toBe(error);
  expect(clearRefreshCookie).toHaveBeenCalledWith(res);
  expect(res.status).not.toHaveBeenCalled();
});

test("transient refresh failures preserve the cookie for a later retry", async () => {
  const error = new Error("Database temporarily unavailable");
  rotateRefreshSession.mockRejectedValue(error);
  const res = response();
  await expect(refreshSessionController({} as Request, res as unknown as Response)).rejects.toBe(error);
  expect(clearRefreshCookie).not.toHaveBeenCalled();
  expect(setRefreshCookie).not.toHaveBeenCalled();
  expect(res.status).not.toHaveBeenCalled();
});

test.each(["original-token", undefined])("logout revokes the session before clearing its cookie: %s", async token => {
  readRefreshCookie.mockReturnValue(token);
  const res = response();
  await logoutSessionController({} as Request, res as unknown as Response);
  expect(logoutSession).toHaveBeenCalledWith(token);
  expect(logoutSession.mock.invocationCallOrder[0]).toBeLessThan(clearRefreshCookie.mock.invocationCallOrder[0]!);
  expect(res.status).toHaveBeenCalledWith(204);
  expect(res.send).toHaveBeenCalledWith();
  expect(res.json).not.toHaveBeenCalled();
});

test("failed logout does not pretend that server-side revocation succeeded", async () => {
  const error = new Error("Logout write failed");
  logoutSession.mockRejectedValue(error);
  const res = response();
  await expect(logoutSessionController({} as Request, res as unknown as Response)).rejects.toBe(error);
  expect(clearRefreshCookie).not.toHaveBeenCalled();
  expect(res.status).not.toHaveBeenCalled();
});
