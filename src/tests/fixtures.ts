import type { users } from "../db/schema.ts";

type UserRow = Omit<typeof users.$inferSelect, "profilePicKey"> & {
  profile_pic_key: string | null;
};

export function userFixture(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 42,
    name: "Learner",
    email: "learner@example.com",
    password: "test-only-password-hash",
    role: "user",
    profile_pic_key: null,
    ...overrides,
  };
}
