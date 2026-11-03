import { afterAll, beforeEach, expect, jest, test } from "@jest/globals";
import type { Request, Response } from "express";
import { errors } from "@vinejs/vine";
import errorHandling from "../middleware/error-handling.ts";
import { AppError } from "../shared/app-error.ts";

const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
beforeEach(() => { errorLog.mockClear(); });
afterAll(() => { errorLog.mockRestore(); });

function response() {
  return {
    headersSent: false,
    locals: { requestId: "test-request-id" },
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

test.each([
  { status: 404, code: "NOT_FOUND", message: "Workspace not found" },
  { status: 403, code: "FORBIDDEN", message: "Permission denied" },
])("returns $status for an application error", ({ status, code, message }) => {
  const res = response();
  const next = jest.fn();

  errorHandling(
    new AppError(status, code, message),
    {} as Request,
    res as unknown as Response,
    next,
  );

  expect(res.status).toHaveBeenCalledWith(status);
  expect(res.json).toHaveBeenCalledWith({
    error: { code, message, requestId: "test-request-id" },
  });
  expect(errorLog).not.toHaveBeenCalled();
  expect(next).not.toHaveBeenCalled();
});

test("unexpected errors include the request ID and log only safe structured fields", () => {
  const res = response();
  const next = jest.fn();
  const error = new Error("password=test-only-secret");

  errorHandling(error, {} as Request, res as unknown as Response, next);

  expect(res.status).toHaveBeenCalledWith(500);
  expect(res.json).toHaveBeenCalledWith({
    success: false,
    message: "Internal server error",
    requestId: "test-request-id",
  });
  expect(errorLog).toHaveBeenCalledTimes(1);
  expect(JSON.parse(errorLog.mock.calls[0]![0])).toEqual({
    level: "error", requestId: "test-request-id", error: "Error", status: 500,
  });
  expect(errorLog.mock.calls[0]![0]).not.toContain(error.message);
  expect(next).not.toHaveBeenCalled();
});

test("validation responses retain field errors and include the request ID", () => {
  const messages = [{ field: "name", rule: "required", message: "Name is required" }];
  const res = response();
  const next = jest.fn();

  errorHandling(new errors.E_VALIDATION_ERROR(messages), {} as Request, res as unknown as Response, next);

  expect(res.status).toHaveBeenCalledWith(422);
  expect(res.json).toHaveBeenCalledWith({
    success: false, message: "Validation failed", errors: messages, requestId: "test-request-id",
  });
  expect(errorLog).not.toHaveBeenCalled();
  expect(next).not.toHaveBeenCalled();
});

test("already-started responses delegate to Express without writing another response", () => {
  const res = response();
  res.headersSent = true;
  const error = new Error("Response already started");
  const next = jest.fn();

  errorHandling(error, {} as Request, res as unknown as Response, next);

  expect(next).toHaveBeenCalledWith(error);
  expect(res.status).not.toHaveBeenCalled();
  expect(res.json).not.toHaveBeenCalled();
  expect(errorLog).not.toHaveBeenCalled();
});

test.each([false, true])("email conflicts return a safe 409 response (wrapped: %s)", wrapped => {
  const databaseError = Object.assign(new Error("sensitive database detail"), {
    code: "23505", constraint: "users_email_unique", detail: "private@example.com already exists",
  });
  const error = wrapped ? Object.assign(new Error("SQL parameters contain private values"), { cause: databaseError }) : databaseError;
  const res = response();
  const next = jest.fn();
  errorHandling(error, {} as Request, res as unknown as Response, next);
  expect(res.status).toHaveBeenCalledWith(409);
  expect(res.json).toHaveBeenCalledWith({ error: {
    code: "EMAIL_ALREADY_EXISTS", message: "Email is already in use", requestId: "test-request-id",
  } });
  expect(errorLog).not.toHaveBeenCalled();
  expect(next).not.toHaveBeenCalled();
});

test("unrelated unique constraints remain server errors", () => {
  const res = response();
  const error = Object.assign(new Error("Other unique conflict"), { cause: { code: "23505", constraint: "different_index" } });
  errorHandling(error, {} as Request, res as unknown as Response, jest.fn());
  expect(res.status).toHaveBeenCalledWith(500);
  expect(res.json).toHaveBeenCalledWith({ success: false, message: "Internal server error", requestId: "test-request-id" });
});

test.each([false, true])("status-name conflicts return a safe 409 response (wrapped: %s)", wrapped => {
  const databaseError = Object.assign(new Error("sensitive SQL values"), { code: "23505", constraint: "project_statuses_project_name_unique" });
  const error = wrapped ? Object.assign(new Error("SQL statement"), { cause: databaseError }) : databaseError;
  const res = response();
  errorHandling(error, {} as Request, res as unknown as Response, jest.fn());
  expect(res.status).toHaveBeenCalledWith(409);
  expect(res.json).toHaveBeenCalledWith({ error: { code: "STATUS_ALREADY_EXISTS", message: "A status with this name already exists", requestId: "test-request-id" } });
  expect(errorLog).not.toHaveBeenCalled();
});
