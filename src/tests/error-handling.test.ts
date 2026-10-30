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
