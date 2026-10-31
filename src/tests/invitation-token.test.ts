import { expect, test } from "@jest/globals";
import { generateInvitationToken, hashInvitationToken } from "../shared/invitation-token.ts";

test("hashes tokens deterministically using SHA-256", () => {
  expect(hashInvitationToken("abc"))
    .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(hashInvitationToken("different-token")).not.toBe(hashInvitationToken("abc"));
});

test("generates fresh 32-byte tokens and their matching hashes", () => {
  const first = generateInvitationToken();
  const second = generateInvitationToken();
  expect(first.token).toMatch(/^[a-f0-9]{64}$/);
  expect(first.tokenHash).toBe(hashInvitationToken(first.token));
  expect(first.tokenHash).not.toBe(first.token);
  expect(second.token).not.toBe(first.token);
});
