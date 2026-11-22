import { expect, test } from "@jest/globals";
import { createHash } from "node:crypto";
import { generatePasswordResetToken, hashPasswordResetToken } from "../shared/password-reset-token.ts";

test("reset links contain 32 random bytes and store only the SHA-256 hash", () => {
  const first = generatePasswordResetToken();
  const second = generatePasswordResetToken();
  expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(Buffer.from(first.token, "base64url")).toHaveLength(32);
  expect(first.tokenHash).toBe(createHash("sha256").update(first.token).digest("hex"));
  expect(first.tokenHash).toHaveLength(64);
  expect(first.token).not.toBe(second.token);
  expect(first.tokenHash).not.toBe(second.tokenHash);
});

test("hashing a submitted token reproduces the stored hash", () => {
  const generated = generatePasswordResetToken();
  expect(hashPasswordResetToken(generated.token)).toBe(generated.tokenHash);
  expect(hashPasswordResetToken(generated.token + "x")).not.toBe(generated.tokenHash);
});
