import { beforeEach, expect, jest, test } from "@jest/globals";

type Profile = { id: number; name: string | null; email: string | null };
const updateUserProfile = jest.fn<(id: number, changes: { name?: string; email?: string }, tx?: object) => Promise<Profile | undefined>>();
const tx = {};
const transaction = jest.fn<(callback: (tx: object) => Promise<unknown>) => Promise<unknown>>();
const lockAuthUser = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const invalidatePasswordResetToken = jest.fn<(...args: unknown[]) => Promise<void>>();
jest.unstable_mockModule("../db/index.js", () => ({ db: { transaction } }));
jest.unstable_mockModule("../repositories/refresh-session.repository.js", () => ({ lockAuthUser }));
jest.unstable_mockModule("../repositories/password-reset-repository.js", () => ({ invalidatePasswordResetToken }));
jest.unstable_mockModule("../repositories/user.repository.js", () => ({ updateUserProfile }));
const { editCurrentUserProfile } = await import("../services/user.service.ts");

beforeEach(() => {
  updateUserProfile.mockReset();
  transaction.mockReset().mockImplementation(callback => callback(tx));
  lockAuthUser.mockReset().mockResolvedValue({ id: 42, email: "original@example.com" });
  invalidatePasswordResetToken.mockReset().mockResolvedValue(undefined);
});

test.each([{}, { name: undefined, email: undefined }])("empty profile edits are rejected before a database write: %j", async changes => {
  await expect(editCurrentUserProfile(42, changes)).rejects.toMatchObject({ statusCode: 422, code: "EMPTY_UPDATE" });
  expect(updateUserProfile).not.toHaveBeenCalled();
});

test.each([{ name: "Updated name" }, { email: "updated@example.com" }, { name: "Updated name", email: "updated@example.com" }])(
  "profile service supports partial and full edits: %j", async changes => {
    const profile = { id: 42, name: "Updated name", email: "updated@example.com" };
    updateUserProfile.mockResolvedValue(profile);
    expect(await editCurrentUserProfile(42, changes)).toEqual(profile);
    expect(updateUserProfile).toHaveBeenCalledWith(42, changes, tx);
  },
);

test("profile edits return not found for a missing account", async () => {
  updateUserProfile.mockResolvedValue(undefined);
  await expect(editCurrentUserProfile(42, { name: "Updated name" })).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
});

test("profile service propagates failed writes", async () => {
  const error = new Error("Test write failure");
  updateUserProfile.mockRejectedValue(error);
  await expect(editCurrentUserProfile(42, { name: "Updated name" })).rejects.toBe(error);
  expect(invalidatePasswordResetToken).not.toHaveBeenCalled();
});

test("changed email invalidates recovery through the same transaction", async () => {
  updateUserProfile.mockResolvedValue({ id: 42, name: "Learner", email: "new@example.com" });
  await editCurrentUserProfile(42, { email: "new@example.com" });
  expect(invalidatePasswordResetToken).toHaveBeenCalledWith(tx, 42, expect.any(Date));
  expect(lockAuthUser.mock.invocationCallOrder[0]).toBeLessThan(updateUserProfile.mock.invocationCallOrder[0]!);
});

test.each([{ name: "Updated name" }, { email: "original@example.com" }])(
  "name-only or unchanged-email edits preserve recovery: %j", async changes => {
    updateUserProfile.mockResolvedValue({ id: 42, name: "Updated name", email: "original@example.com" });
    await editCurrentUserProfile(42, changes);
    expect(invalidatePasswordResetToken).not.toHaveBeenCalled();
  },
);

test("a deleted account is rejected before any profile write", async () => {
  lockAuthUser.mockResolvedValue(null);
  await expect(editCurrentUserProfile(42, { email: "new@example.com" }))
    .rejects.toMatchObject({ statusCode: 404 });
  expect(updateUserProfile).not.toHaveBeenCalled();
});
