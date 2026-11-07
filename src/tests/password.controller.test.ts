import { beforeEach, expect, jest, test } from "@jest/globals";
import type { Request, Response } from "express";
import { AppError } from "../shared/app-error.ts";

const changeCurrentUserPassword = jest.fn<
  typeof import("../services/password.service.ts").changeCurrentUserPassword
>();
const clearRefreshCookie = jest.fn();
jest.unstable_mockModule("../services/password.service.js", () => ({ changeCurrentUserPassword }));
jest.unstable_mockModule("../auth/refresh-cookie.js", () => ({ clearRefreshCookie }));
const { changePasswordController } = await import("../controllers/password.controller.ts");

const validatedData = {
  currentPassword: "current-test-password",
  newPassword: "new-test-password",
};

function response() {
  return {
    locals: { validatedData },
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
}

beforeEach(() => {
  changeCurrentUserPassword.mockReset().mockResolvedValue(undefined);
  clearRefreshCookie.mockReset();
});

test("uses the authenticated user and validated passwords, then clears the cookie", async () => {
  const req = { user: { userId: 42 }, body: { userId: 99 } } as unknown as Request;
  const res = response();
  await changePasswordController(req, res as unknown as Response);

  expect(changeCurrentUserPassword).toHaveBeenCalledWith(42, validatedData.currentPassword, validatedData.newPassword);
  expect(clearRefreshCookie).toHaveBeenCalledWith(res);
  expect(changeCurrentUserPassword.mock.invocationCallOrder[0])
    .toBeLessThan(clearRefreshCookie.mock.invocationCallOrder[0]!);
  expect(res.status).toHaveBeenCalledWith(204);
  expect(res.send).toHaveBeenCalledWith();
});

test("a failed password change leaves the cookie intact", async () => {
  const failure = new AppError(422, "INVALID_CURRENT_PASSWORD", "Current password is incorrect");
  changeCurrentUserPassword.mockRejectedValue(failure);
  const req = { user: { userId: 42 } } as unknown as Request;
  const res = response();
  await expect(changePasswordController(req, res as unknown as Response)).rejects.toBe(failure);
  expect(clearRefreshCookie).not.toHaveBeenCalled();
  expect(res.status).not.toHaveBeenCalled();
});

test.each([undefined, "42", 0, -1, 0.5, 2147483648])("rejects an invalid user ID: %s", async userId => {
  const req = { user: { userId } } as unknown as Request;
  const res = response();
  await expect(changePasswordController(req, res as unknown as Response))
    .rejects.toMatchObject({ statusCode: 401, code: "UNAUTHENTICATED" });
  expect(changeCurrentUserPassword).not.toHaveBeenCalled();
  expect(clearRefreshCookie).not.toHaveBeenCalled();
});
