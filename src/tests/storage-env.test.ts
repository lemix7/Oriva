import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";

const settings = ["AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_BUCKET_NAME"] as const;
const original = Object.fromEntries(settings.map((name) => [name, process.env[name]]));
const send = jest.fn();

jest.unstable_mockModule("dotenv", () => ({ default: { config: jest.fn() } }));
jest.unstable_mockModule("@aws-sdk/client-s3", () => ({
  S3Client: class { send = send; },
  PutObjectCommand: class {},
  DeleteObjectCommand: class {},
}));

beforeEach(() => {
  jest.resetModules();
  send.mockReset();
  for (const name of settings) process.env[name] = "test-only-setting";
});

afterEach(() => {
  for (const name of settings) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
});

test.each(settings)("upload adapter cannot initialize without %s", async (name) => {
  delete process.env[name];
  await expect(import("../adapters/profile-pic-storage.adapter.ts"))
    .rejects.toThrow(`Missing required environment variable: ${name}`);
  expect(send).not.toHaveBeenCalled();
});
