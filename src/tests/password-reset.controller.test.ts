import { beforeEach, expect, jest, test } from "@jest/globals";
import type { Request, Response } from "express";
import { AppError } from "../shared/app-error.ts";

const add = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const resetPassword = jest.fn<(token: string, password: string) => Promise<void>>();
const clearRefreshCookie = jest.fn();
jest.unstable_mockModule("../queue/email.que.js", () => ({ default: { add } }));
jest.unstable_mockModule("../services/password-reset.service.js", () => ({ resetPassword }));
jest.unstable_mockModule("../auth/refresh-cookie.js", () => ({ clearRefreshCookie }));
const { forgotPasswordController, resetPasswordController } = await import("../controllers/password-reset.controller.ts");

function response(validatedData: object) {
  return {
    locals: { validatedData },
    set: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
}

beforeEach(() => {
  add.mockReset().mockResolvedValue({});
  resetPassword.mockReset().mockResolvedValue(undefined);
  clearRefreshCookie.mockReset();
});

test("request controller queues the validated email and returns a generic acceptance", async () => {
  const res = response({ email: "sara@test.local" });
  await forgotPasswordController({ body: { email: "ignored@test.local" } } as Request, res as unknown as Response);
  expect(add).toHaveBeenCalledWith("requestPasswordReset", { email: "sara@test.local" }, {
    attempts: 1, removeOnComplete: true, removeOnFail: true,
  });
  expect(res.status).toHaveBeenCalledWith(202);
  expect(res.set).toHaveBeenCalledWith("Cache-Control", "no-store");
  expect(res.json).toHaveBeenCalledWith({
    message: "If an account exists with that email, we’ll send a password-reset link.",
  });
});

test("a queue failure propagates instead of reporting an accepted request", async () => {
  const error = new Error("Queue unavailable");
  add.mockRejectedValue(error);
  const res = response({ email: "sara@test.local" });
  await expect(forgotPasswordController({} as Request, res as unknown as Response)).rejects.toBe(error);
  expect(res.status).not.toHaveBeenCalled();
});

test("reset uses validated credentials and clears the cookie after success", async () => {
  const res = response({ token: "reset-token", newPassword: "replacement-password" });
  await resetPasswordController({} as Request, res as unknown as Response);
  expect(resetPassword).toHaveBeenCalledWith("reset-token", "replacement-password");
  expect(resetPassword.mock.invocationCallOrder[0]).toBeLessThan(clearRefreshCookie.mock.invocationCallOrder[0]!);
  expect(res.status).toHaveBeenCalledWith(204);
  expect(res.send).toHaveBeenCalledWith();
  expect(res.json).not.toHaveBeenCalled();
});

test.each([
  new AppError(400, "INVALID_RESET_TOKEN", "Invalid reset link"),
  new Error("Transaction failed"),
])("reset failures preserve the cookie and propagate: %s", async error => {
  resetPassword.mockRejectedValue(error);
  const res = response({ token: "reset-token", newPassword: "replacement-password" });
  await expect(resetPasswordController({} as Request, res as unknown as Response)).rejects.toBe(error);
  expect(clearRefreshCookie).not.toHaveBeenCalled();
  expect(res.status).not.toHaveBeenCalled();
});
