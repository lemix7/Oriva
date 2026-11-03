import { expect, test } from "@jest/globals";
import { isDuplicateEmailError, isDuplicateProjectStatusNameError } from "../shared/database-errors.ts";

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

test.each([false, true])("identifies status-name conflicts without confusing them with emails (wrapped: %s)", wrapped => {
  const cause = { code: "23505", constraint: "project_statuses_project_name_unique" };
  const error = wrapped ? { cause } : cause;
  expect(isDuplicateProjectStatusNameError(error)).toBe(true);
  expect(isDuplicateEmailError(error)).toBe(false);
  expect(isDuplicateProjectStatusNameError(duplicate)).toBe(false);
});

test.each([undefined, null, "error", { cause: null }, { code: "23503", constraint: "project_statuses_project_name_unique" }, { cause: { code: "23505", constraint: "other_unique" } }])(
  "unrelated errors are not status-name conflicts: %j", error => {
    expect(isDuplicateProjectStatusNameError(error)).toBe(false);
  },
);
