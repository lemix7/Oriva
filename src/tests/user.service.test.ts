import { beforeEach, expect, jest, test } from "@jest/globals";

type Profile = { id: number; name: string | null; email: string | null };
const updateUserProfile = jest.fn<(id: number, changes: { name?: string; email?: string }) => Promise<Profile | undefined>>();
jest.unstable_mockModule("../repositories/user.repository.js", () => ({ updateUserProfile }));
const { editCurrentUserProfile } = await import("../services/user.service.ts");

beforeEach(() => { updateUserProfile.mockReset(); });

test.each([{}, { name: undefined, email: undefined }])("empty profile edits are rejected before a database write: %j", async changes => {
  await expect(editCurrentUserProfile(42, changes)).rejects.toMatchObject({ statusCode: 422, code: "EMPTY_UPDATE" });
  expect(updateUserProfile).not.toHaveBeenCalled();
});

test.each([{ name: "Updated name" }, { email: "updated@example.com" }, { name: "Updated name", email: "updated@example.com" }])(
  "profile service supports partial and full edits: %j", async changes => {
    const profile = { id: 42, name: "Updated name", email: "updated@example.com" };
    updateUserProfile.mockResolvedValue(profile);
    expect(await editCurrentUserProfile(42, changes)).toEqual(profile);
    expect(updateUserProfile).toHaveBeenCalledWith(42, changes);
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
});
