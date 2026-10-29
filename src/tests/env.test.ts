import { afterEach, expect, jest, test } from "@jest/globals";

jest.unstable_mockModule("dotenv", () => ({ default: { config: jest.fn() } }));
const { requiredEnv } = await import("../config/env.ts");
const setting = "ORIVA_REQUIRED_ENV_TEST";
const original = process.env[setting];

afterEach(() => {
  if (original === undefined) delete process.env[setting];
  else process.env[setting] = original;
});

test.each([undefined, "", "   "])("rejects a missing or empty setting: %j", (value) => {
  if (value === undefined) delete process.env[setting];
  else process.env[setting] = value;
  expect(() => requiredEnv(setting))
    .toThrow(`Missing required environment variable: ${setting}`);
});

test("returns the original literal value without trimming or interpreting dollar signs", () => {
  process.env[setting] = "  literal$test-value  ";
  expect(requiredEnv(setting)).toBe("  literal$test-value  ");
});
