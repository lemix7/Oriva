import { createHash, randomBytes } from "node:crypto";

export function hashPasswordResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generatePasswordResetToken() {
  const token = randomBytes(32).toString("base64url");

  return {
    token,
    tokenHash: hashPasswordResetToken(token),
  };
}



