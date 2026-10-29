import type { tasks, users } from "../db/schema.ts";

type ProjectRow = Awaited<
  ReturnType<typeof import("../repositories/project.repository.ts").getAllProject>
>[number];
type UserRow = Omit<typeof users.$inferSelect, "profilePicKey"> & {
  profile_pic_key: string | null;
};
type TaskRow = Omit<typeof tasks.$inferSelect, "projectId" | "createdAt"> & {
  project_id: number;
  created_at: Date | null;
};

// Complete API-shaped rows keep controller mocks realistic as repositories
// gain precise Drizzle return types. Type-only imports never open a connection.
export function projectFixture(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: 7,
    name: "Test project",
    description: "Learning tests",
    status: "active",
    created_at: new Date("2026-01-01T00:00:00Z"),
    user_id: 42,
    task_cache_version: "0",
    ...overrides,
  };
}

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

export function taskFixture(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 10,
    title: "Write tests",
    project_id: 7,
    description: "Learning tests",
    status: "on progress",
    created_at: new Date(2026, 0, 1),
    ...overrides,
  };
}

type JoinedTaskRow = Awaited<
  ReturnType<typeof import("../repositories/task.repository.ts").findTaskForUser>
>[number];

export function joinedTaskFixture(overrides: Partial<JoinedTaskRow> = {}): JoinedTaskRow {
  return { ...taskFixture(), ...projectFixture(), ...overrides };
}
