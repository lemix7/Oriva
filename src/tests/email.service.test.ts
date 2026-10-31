import { afterAll, beforeEach, expect, jest, test } from "@jest/globals";
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

const originalApiKey = process.env.RESEND_API_KEY;
const originalEmailFrom = process.env.EMAIL_FROM;
process.env.RESEND_API_KEY = "unit-test-resend-key";
const { default: newUserEmail, sendInvitationEmail } = await import("../services/email.service.ts");

afterAll(() => {
  if (originalApiKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalApiKey;
  if (originalEmailFrom === undefined) delete process.env.EMAIL_FROM;
  else process.env.EMAIL_FROM = originalEmailFrom;
});

beforeEach(() => {
  send.mockReset();
  process.env.EMAIL_FROM = "Oriva <invite@test.local>";
});

test("invitation email uses the recipient, configured sender, token, and idempotency key", async () => {
  send.mockResolvedValue({ data: { id: "invitation-email" }, error: null });
  await expect(sendInvitationEmail("sara@test.local", "test-only-token", "invite/7"))
    .resolves.toEqual({ id: "invitation-email" });
  expect(send).toHaveBeenCalledWith({
    from: "Oriva <invite@test.local>", to: "sara@test.local",
    subject: "You're invited to an Oriva workspace",
    text: expect.stringContaining("Invitation token: test-only-token"),
  }, { idempotencyKey: "invite/7", signal: expect.any(AbortSignal) });
});

test("invitation delivery requires a configured sender before contacting the provider", async () => {
  delete process.env.EMAIL_FROM;
  await expect(sendInvitationEmail("sara@test.local", "test-only-token", "invite/7"))
    .rejects.toThrow("Missing required environment variable: EMAIL_FROM");
  expect(send).not.toHaveBeenCalled();
});

test.each([
  { name: "application_error", statusCode: 503 },
  { name: "rate_limit_exceeded", statusCode: 429 },
  { name: "concurrent_idempotent_requests", statusCode: 409 },
  { name: "application_error", statusCode: 408 },
  { name: "application_error", statusCode: null },
])("invitation delivery retries $name ($statusCode)", async (error) => {
  send.mockResolvedValue({ data: null, error: { ...error, message: "Temporary failure" } });
  const result = sendInvitationEmail("sara@test.local", "test-only-token", "invite/7");
  await expect(result).rejects.toThrow("Temporary failure");
  await expect(result).rejects.not.toBeInstanceOf(UnrecoverableError);
});

test("invitation permanent failures stop retries", async () => {
  send.mockResolvedValue({ data: null, error: {
    name: "validation_error", statusCode: 422, message: "Invalid recipient",
  } });
  await expect(sendInvitationEmail("sara@test.local", "test-only-token", "invite/7"))
    .rejects.toBeInstanceOf(UnrecoverableError);
});

test("invitation network errors propagate and missing provider results fail", async () => {
  send.mockRejectedValueOnce(new Error("Network unavailable"));
  await expect(sendInvitationEmail("sara@test.local", "test-only-token", "invite/7"))
    .rejects.toThrow("Network unavailable");
  send.mockResolvedValue({ data: null, error: null });
  await expect(sendInvitationEmail("sara@test.local", "test-only-token", "invite/7"))
    .rejects.toThrow("Email provider returned no result");
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

test("email service cannot initialize without its API key", async () => {
  const key = process.env.RESEND_API_KEY;
  try {
    delete process.env.RESEND_API_KEY;
    jest.resetModules();
    await expect(import("../services/email.service.ts"))
      .rejects.toThrow("Missing required environment variable: RESEND_API_KEY");
    expect(send).not.toHaveBeenCalled();
  } finally {
    if (key === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = key;
  }
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
