import { beforeEach, expect, jest, test } from "@jest/globals";
import { AppError } from "../shared/app-error.ts";

type Repository = typeof import("../repositories/workspace.repository.ts");
const getWorkspaceById = jest.fn<Repository["getWorkspaceById"]>();
type Membership = NonNullable<
  Awaited<ReturnType<Repository["getWorkspaceMembership"]>>
>;
// SQL may return no row, even though this project's TS settings infer a row.
const getWorkspaceMembership =
  jest.fn<
    (workspaceId: number, userId: number) => Promise<Membership | undefined>
  >();

// Isolate permission decisions from database connections and writes.
jest.unstable_mockModule("../db/index.js", () => ({
  db: { transaction: jest.fn() },
}));
jest.unstable_mockModule("../repositories/workspace.repository.js", () => ({
  getWorkspaceMembership,
  getWorkspaceById,
  insertWorkspace: jest.fn(),
  insertOwnerMembership: jest.fn(),
  getWorkspacesByUserId: jest.fn(),
  WORKSPACE_PAGE_SIZE: 20,
  getWorkspaceMembers: jest.fn(),
  MEMBER_PAGE_SIZE: 20,
  lockWorkspace: jest.fn(),
  updateWorkspaceMemberRole: jest.fn(),
  deleteWorkspaceMember: jest.fn(),
  demoteWorkspaceOwner: jest.fn(),
  promoteWorkspaceOwner: jest.fn(),
}));

jest.unstable_mockModule("../repositories/invitations.repository.js", () => ({
  getInvitationRecipient: jest.fn(),
  revokePendingInvitations: jest.fn(),
}));

const { requireWorkspaceMembership, requireWorkspaceRole } = await import(
  "../services/workspaces.service.ts"
);

beforeEach(() => {
  getWorkspaceMembership.mockReset();
  getWorkspaceById.mockReset();
});

function membership(role: Membership["role"]): Membership {
  return { workspaceId: 7, userId: 42, role };
}

test.each(["owner", "editor", "viewer"] as const)(
  "returns the membership for a workspace %s",
  async (role) => {
    const record = membership(role);
    getWorkspaceMembership.mockResolvedValue(record);

    await expect(requireWorkspaceMembership(7, 42)).resolves.toEqual(record);
    expect(getWorkspaceMembership).toHaveBeenCalledWith(7, 42);
  },
);

test("rejects a non-member with 404", async () => {
  getWorkspaceMembership.mockResolvedValue(undefined);

  const result = requireWorkspaceMembership(7, 42);

  await expect(result).rejects.toBeInstanceOf(AppError);
  await expect(result).rejects.toMatchObject({
    statusCode: 404,
    code: "NOT_FOUND",
    message: "Workspace not found",
  });
});

test.each(["owner", "editor"] as const)(
  "allows an %s when owners and editors are permitted",
  async (role) => {
    const record = membership(role);
    getWorkspaceMembership.mockResolvedValue(record);

    await expect(
      requireWorkspaceRole(7, 42, ["owner", "editor"]),
    ).resolves.toEqual(record);
    expect(getWorkspaceMembership).toHaveBeenCalledWith(7, 42);
  },
);

test.each(["editor", "viewer"] as const)(
  "rejects an %s for an owner-only action with 403",
  async (role) => {
    getWorkspaceMembership.mockResolvedValue(membership(role));

    const result = requireWorkspaceRole(7, 42, ["owner"]);

    await expect(result).rejects.toBeInstanceOf(AppError);
    await expect(result).rejects.toMatchObject({
      statusCode: 403,
      code: "FORBIDDEN",
    });
  },
);

test("allows a viewer when viewers are explicitly permitted", async () => {
  const record = membership("viewer");
  getWorkspaceMembership.mockResolvedValue(record);

  await expect(
    requireWorkspaceRole(7, 42, ["owner", "editor", "viewer"]),
  ).resolves.toEqual(record);
});

test("role checks reject outsiders with 404 before checking their role", async () => {
  getWorkspaceMembership.mockResolvedValue(undefined);

  await expect(requireWorkspaceRole(7, 42, ["owner"])).rejects.toMatchObject({
    statusCode: 404,
    code: "NOT_FOUND",
  });
});

test("an empty allowed-role list denies a member", async () => {
  getWorkspaceMembership.mockResolvedValue(membership("owner"));

  await expect(requireWorkspaceRole(7, 42, [])).rejects.toMatchObject({
    statusCode: 403,
    code: "FORBIDDEN",
  });
});

test("database failures propagate instead of being reported as missing membership", async () => {
  const error = new Error("Database unavailable");
  getWorkspaceMembership.mockRejectedValue(error);

  await expect(requireWorkspaceRole(7, 42, ["owner"])).rejects.toBe(error);
});
