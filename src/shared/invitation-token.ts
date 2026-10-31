import { createHash, randomBytes } from "node:crypto";

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateInvitationToken() {
  const token = randomBytes(32).toString("hex");

  return {
    token,
    tokenHash: hashInvitationToken(token),
  };
}