import { expect, test } from "@jest/globals";
import { isDuplicateEmailError } from "../shared/database-errors.ts";

const duplicate = { code: "23505", constraint: "users_email_unique" };

test.each([duplicate, { cause: duplicate }])("recognizes raw and Drizzle-wrapped email conflicts: %j", error => {
  expect(isDuplicateEmailError(error)).toBe(true);
});

test.each([
  undefined, null, "23505", new Error("Other failure"),
  { code: "23505", constraint: "another_unique_index" },
  { code: "23503", constraint: "users_email_unique" },
  { cause: { code: "23505", constraint: "another_unique_index" } },
  { cause: null },
])("does not misidentify unrelated errors: %j", error => {
  expect(isDuplicateEmailError(error)).toBe(false);
});
