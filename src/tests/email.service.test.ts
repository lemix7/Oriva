import { beforeEach, expect, jest, test } from "@jest/globals";
import { UnrecoverableError } from "bullmq";

const send = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));

jest.unstable_mockModule("dotenv", () => ({
  default: { config: jest.fn() },
}));

const { default: newUserEmail } = await import("../services/email.service.ts");

beforeEach(() => {
  send.mockReset();
});

test("invalid credentials cause an unrecoverable failure", async () => {
  send.mockResolvedValue({
    data: null,
    error: {
      name: "validation_error",
      statusCode: 401,
      message: "Invalid API key",
    },
  });

  await expect(newUserEmail("Test user", "test-email-key"))
    .rejects.toBeInstanceOf(UnrecoverableError);

  expect(send).toHaveBeenCalledTimes(1);
});

test.each([
  { name: "application_error", statusCode: 503 },
  { name: "rate_limit_exceeded", statusCode: 429 },
  { name: "application_error", statusCode: 408 },
  { name: "concurrent_idempotent_requests", statusCode: 409 },
  { name: "application_error", statusCode: null },
])("temporary failure $name ($statusCode) remains retryable", async (error) => {
  send.mockResolvedValue({
    data: null,
    error: { ...error, message: "Temporary provider failure" },
  });

  const result = newUserEmail("Test user", "test-email-key");

  await expect(result).rejects.toBeInstanceOf(Error);
  await expect(result).rejects.not.toBeInstanceOf(UnrecoverableError);
  await expect(result).rejects.toThrow("Temporary provider failure");
  expect(send).toHaveBeenCalledTimes(1);
});
