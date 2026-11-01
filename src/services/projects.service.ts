import { db } from "../db/index.ts";
import {
  lockWorkspace,
  getWorkspaceMembership,
} from "../repositories/workspace.repository.ts";
import {
  deleteWorkspaceProject,
  findWorkspaceProject,
  getWorkspaceProjects,
  insertWorkspaceProject,
  PROJECT_PAGE_SIZE,
  projectHasTasks,
  updateWorkspaceProject,
} from "../repositories/project.repository.ts";
import { AppError } from "../shared/app-error.ts";
import { requireWorkspaceMembership } from "./workspaces.service.ts";

export async function createWorkspaceProject(
  workspaceId: number,
  actorId: number,
  input: {
    name: string;
    description?: string;
    status: string;
  },
) {
  return db.transaction(async (tx) => {
    const workspace = await lockWorkspace(tx, workspaceId);
    const membership = await getWorkspaceMembership(workspaceId, actorId, tx);

    if (!workspace || !membership) {
      throw new AppError(404, "NOT_FOUND", "Workspace not found");
    }

    if (membership.role === "viewer") {
      throw new AppError(
        403,
        "FORBIDDEN",
        "Only owners and editors can create projects",
      );
    }

    const project = await insertWorkspaceProject(
      tx,
      workspaceId,
      actorId,
      input,
    );

    if (!project) {
      throw new Error("Project insert returned no row");
    }

    return project;
  });
}

export async function listWorkspaceProjects(
  workspaceId: number,
  userId: number,
  afterId = 0,
) {
  await requireWorkspaceMembership(workspaceId, userId);

  const results = await getWorkspaceProjects(workspaceId, afterId);
  const hasNextPage = results.length > PROJECT_PAGE_SIZE;
  const data = results.slice(0, PROJECT_PAGE_SIZE);

  return {
    data,
    nextCursor: hasNextPage ? data[data.length - 1].id : null,
  };
}

export async function getWorkspaceProject(
  workspaceId: number,
  projectId: number,
  userId: number,
) {
  await requireWorkspaceMembership(workspaceId, userId);

  const project = await findWorkspaceProject(workspaceId, projectId);

  if (!project) {
    throw new AppError(404, "NOT_FOUND", "Project not found");
  }

  return project;
}

export async function editWorkspaceProject(
  workspaceId: number,
  projectId: number,
  actorId: number,
  changes: {
    name?: string;
    description?: string | null;
    status?: string;
  },
) {
  return db.transaction(async (tx) => {
    const workspace = await lockWorkspace(tx, workspaceId);
    const membership = await getWorkspaceMembership(workspaceId, actorId, tx);

    if (!workspace || !membership) {
      throw new AppError(404, "NOT_FOUND", "Workspace not found");
    }

    if (membership.role === "viewer") {
      throw new AppError(
        403,
        "FORBIDDEN",
        "Only owners and editors can update projects",
      );
    }

    const hasChanges =
      changes.name !== undefined ||
      changes.description !== undefined ||
      changes.status !== undefined;

    if (!hasChanges) {
      throw new AppError(
        422,
        "EMPTY_UPDATE",
        "Provide at least one editable field",
      );
    }

    const project = await updateWorkspaceProject(
      tx,
      workspaceId,
      projectId,
      changes,
    );

    if (!project) {
      throw new AppError(404, "NOT_FOUND", "Project not found");
    }

    return project;
  });
}

export async function removeWorkspaceProject(
  workspaceId: number,
  projectId: number,
  actorId: number,
) {
  return db.transaction(async (tx) => {
    const workspace = await lockWorkspace(tx, workspaceId);
    const membership = await getWorkspaceMembership(workspaceId, actorId, tx);

    if (!workspace || !membership) {
      throw new AppError(404, "NOT_FOUND", "Workspace not found");
    }

    if (membership.role !== "owner") {
      throw new AppError(403, "FORBIDDEN", "Only owners can delete projects");
    }

    const project = await findWorkspaceProject(workspaceId, projectId, tx);

    if (!project) {
      throw new AppError(404, "NOT_FOUND", "Project not found");
    }

    if (await projectHasTasks(tx, projectId)) {
      throw new AppError(
        409,
        "PROJECT_NOT_EMPTY",
        "Remove the project's tasks before deleting it",
      );
    }

    const removed = await deleteWorkspaceProject(
      tx,
      workspaceId,
      projectId,
    );

    // Optional: append this catch to the deletion call to return 409 when a
    // legacy task write races with deletion. The foreign key still protects
    // the data without it; that race currently reaches the generic 500 handler.
    /*
    .catch((error: unknown) => {
      const cause = error instanceof Error && error.cause ? error.cause : error;

      if (
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "23503" &&
        "constraint" in cause &&
        cause.constraint === "tasks_project_id_fkey"
      ) {
        throw new AppError(
          409,
          "PROJECT_NOT_EMPTY",
          "Remove the project's tasks before deleting it",
        );
      }

      throw error;
    });
    */

    if (!removed) {
      throw new AppError(404, "NOT_FOUND", "Project not found");
    }
  });
}
