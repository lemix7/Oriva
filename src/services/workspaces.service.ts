import { db } from "../db/index.ts";
import {
  insertWorkspace,
  getWorkspacesByUserId,
  insertOwnerMembership,
  WORKSPACE_PAGE_SIZE,
  getWorkspaceMembership,
  getWorkspaceById,
  MEMBER_PAGE_SIZE,
  getWorkspaceMembers,
  lockWorkspace,
  updateWorkspaceMemberRole,
} from "../repositories/workspace.repository.ts";
import { AppError } from "../shared/app-error.ts";

export async function createWorkspace(name: string, userId: number) {
  return db.transaction(async (tx) => {
    const workspace = await insertWorkspace(tx, name, userId);

    await insertOwnerMembership(tx, workspace.id, userId);

    return workspace;
  });
}

export async function listWorkspaces(userId: number, afterId: number) {
  const results = await getWorkspacesByUserId(userId, afterId);
  const hasNextPage = results.length > WORKSPACE_PAGE_SIZE;
  const data = hasNextPage ? results.slice(0, WORKSPACE_PAGE_SIZE) : results;

  return {
    data,
    nextCursor: hasNextPage ? data[data.length - 1].id : null,
  };
}

export async function requireWorkspaceMembership(
  workspaceId: number,
  userId: number,
) {
  const membership = await getWorkspaceMembership(workspaceId, userId);

  if (!membership) {
    throw new AppError(404, "NOT_FOUND", "Workspace not found");
  }

  return membership;
}

type WorkspaceRole = "owner" | "editor" | "viewer";

export async function requireWorkspaceRole(
  workspaceId: number,
  userId: number,
  allowedRoles: readonly WorkspaceRole[],
) {
  const membership = await requireWorkspaceMembership(workspaceId, userId);

  if (!allowedRoles.includes(membership.role)) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "You do not have permission to perform this action",
    );
  }

  return membership;
}

export async function getWorkspace(workspaceId: number, userId: number) {
  await requireWorkspaceMembership(workspaceId, userId);

  const workspace = await getWorkspaceById(workspaceId);

  if (!workspace) {
    throw new AppError(404, "NOT_FOUND", "Workspace not found");
  }

  return workspace;
}

export async function listWorkspaceMembers(
  workspaceId: number,
  userId: number,
  afterUserId = 0,
) {
  await requireWorkspaceMembership(workspaceId, userId);

  const results = await getWorkspaceMembers(workspaceId, afterUserId);
  const hasNextPage = results.length > MEMBER_PAGE_SIZE;
  const data = results.slice(0, MEMBER_PAGE_SIZE);

  return {
    data,
    nextCursor: hasNextPage ? data[data.length - 1].userId : null,
  };
}

export async function changeWorkspaceMemberRole(
  workspaceId: number,
  actorId: number,
  memberId: number,
  role: "editor" | "viewer",
) {
  return db.transaction(async (tx) => {
    const workspace = await lockWorkspace(tx, workspaceId);
    const actor = await getWorkspaceMembership(workspaceId, actorId, tx);

    if (!workspace || !actor) {
      throw new AppError(404, "NOT_FOUND", "Workspace not found");
    }

    if (actor.role !== "owner") {
      throw new AppError(403, "FORBIDDEN", "Only owners can change member roles");
    }

    const member = await getWorkspaceMembership(workspaceId, memberId, tx);

    if (!member) {
      throw new AppError(404, "NOT_FOUND", "Workspace member not found");
    }

    if (member.role === "owner") {
      throw new AppError(
        409,
        "OWNERSHIP_TRANSFER_REQUIRED",
        "Use ownership transfer to change the owner",
      );
    }

    const updated = await updateWorkspaceMemberRole(
      tx, workspaceId, memberId, role,
    );

    if (!updated) {
      throw new AppError(409, "MEMBER_CHANGED", "Workspace member changed");
    }

    return updated;
  });
}