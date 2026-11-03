import { getWorkspaceProject } from "./projects.service.ts";
import { db } from "../db/index.ts";
import {
  deleteProjectStatus,
  getProjectStatuses,
  insertProjectStatus,
  projectStatusHasTasks,
  updateProjectStatus,
} from "../repositories/project-status.repository.ts";
import {
  lockWorkspace,
  getWorkspaceMembership,
} from "../repositories/workspace.repository.ts";
import { findWorkspaceProject } from "../repositories/project.repository.ts";
import { AppError } from "../shared/app-error.ts";

export async function listProjectStatuses(
  workspaceId: number,
  projectId: number,
  userId: number,
) {
  await getWorkspaceProject(workspaceId, projectId, userId);

  return getProjectStatuses(projectId);
}

export async function createProjectStatus(
  workspaceId: number,
  projectId: number,
  actorId: number,
  input: { name: string; isDone?: boolean },
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
        "Only owners and editors can create statuses",
      );
    }

    const project = await findWorkspaceProject(workspaceId, projectId, tx);

    if (!project) {
      throw new AppError(404, "NOT_FOUND", "Project not found");
    }

    const statuses = await getProjectStatuses(projectId, tx);
    const lastStatus = statuses[statuses.length - 1];
    const position = (lastStatus?.position ?? 0) + 1000;

    if (position > 2147483647) {
      throw new AppError(
        409,
        "STATUS_ORDER_LIMIT",
        "Status order needs rebalancing before adding another status",
      );
    }

    const status = await insertProjectStatus(tx, projectId, {
      name: input.name,
      isDone: input.isDone,
      position,
    });

    if (!status) {
      throw new AppError(
        409,
        "STATUS_ALREADY_EXISTS",
        "A status with this name already exists",
      );
    }

    return status;
  });
}

export async function editProjectStatus(
  workspaceId: number,
  projectId: number,
  statusId: number,
  actorId: number,
  changes: {
    name?: string;
    position?: number;
    isDone?: boolean;
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
        "Only owners and editors can edit statuses",
      );
    }

    const project = await findWorkspaceProject(workspaceId, projectId, tx);

    if (!project) {
      throw new AppError(404, "NOT_FOUND", "Project not found");
    }

    if (
      changes.name === undefined &&
      changes.position === undefined &&
      changes.isDone === undefined
    ) {
      throw new AppError(
        422,
        "EMPTY_UPDATE",
        "Provide at least one editable field",
      );
    }

    const status = await updateProjectStatus(tx, projectId, statusId, changes);

    if (!status) {
      throw new AppError(404, "NOT_FOUND", "Project status not found");
    }

    return status;
  });
}

export async function removeProjectStatus(
  workspaceId: number,
  projectId: number,
  statusId: number,
  actorId: number,
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
        "Only owners and editors can delete statuses",
      );
    }

    const project = await findWorkspaceProject(workspaceId, projectId, tx);

    if (!project) {
      throw new AppError(404, "NOT_FOUND", "Project not found");
    }

    if (await projectStatusHasTasks(tx, projectId, statusId)) {
      throw new AppError(
        409,
        "STATUS_IN_USE",
        "Move tasks to another status before deleting this status",
      );
    }

    const status = await deleteProjectStatus(tx, projectId, statusId);

    if (!status) {
      throw new AppError(404, "NOT_FOUND", "Project status not found");
    }

    return status;
  });
}
