import {
  deleteWorkspaceTask,
  findWorkspaceTask,
  getWorkspaceTasks,
  insertWorkspaceTask,
  TASK_PAGE_SIZE,
  updateWorkspaceTask,
} from "../repositories/task.repository.ts";
import { AppError } from "../shared/app-error.ts";
import { getWorkspaceProject } from "./projects.service.ts";
import { db } from "../db/index.ts";
import {
  lockWorkspace,
  getWorkspaceMembership,
} from "../repositories/workspace.repository.ts";
import { findWorkspaceProject } from "../repositories/project.repository.ts";

export async function listWorkspaceTasks(
  workspaceId: number,
  projectId: number,
  userId: number,
  afterId = 0,
) {
  await getWorkspaceProject(workspaceId, projectId, userId);

  const results = await getWorkspaceTasks(workspaceId, projectId, afterId);

  const hasNextPage = results.length > TASK_PAGE_SIZE;
  const data = results.slice(0, TASK_PAGE_SIZE);

  return {
    data,
    nextCursor: hasNextPage ? data[data.length - 1].id : null,
  };
}

export async function getWorkspaceTask(
  workspaceId: number,
  projectId: number,
  taskId: number,
  userId: number,
) {
  await getWorkspaceProject(workspaceId, projectId, userId);

  const task = await findWorkspaceTask(workspaceId, projectId, taskId);

  if (!task) {
    throw new AppError(404, "NOT_FOUND", "Task not found");
  }

  return task;
}

export async function createWorkspaceTask(
  workspaceId: number,
  projectId: number,
  actorId: number,
  input: {
    title: string;
    description?: string;
    status: "done" | "cancelled" | "on progress";
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
        "Only owners and editors can create tasks",
      );
    }

    const project = await findWorkspaceProject(workspaceId, projectId, tx);

    if (!project) {
      throw new AppError(404, "NOT_FOUND", "Project not found");
    }

    const task = await insertWorkspaceTask(tx, projectId, input);

    if (!task) {
      throw new Error("Task insert returned no row");
    }

    return task;
  });
}

export async function editWorkspaceTask(
  workspaceId: number,
  projectId: number,
  taskId: number,
  actorId: number,
  changes: {
    title?: string;
    description?: string | null;
    status?: "done" | "cancelled" | "on progress";
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
        "Only owners and editors can update tasks",
      );
    }

    const project = await findWorkspaceProject(workspaceId, projectId, tx);

    if (!project) {
      throw new AppError(404, "NOT_FOUND", "Project not found");
    }

    if (
      changes.title === undefined &&
      changes.description === undefined &&
      changes.status === undefined
    ) {
      throw new AppError(
        422,
        "EMPTY_UPDATE",
        "Provide at least one editable field",
      );
    }

    const task = await updateWorkspaceTask(tx, projectId, taskId, changes);

    if (!task) {
      throw new AppError(404, "NOT_FOUND", "Task not found");
    }

    return task;
  });
}

export async function removeWorkspaceTask(
  workspaceId: number,
  projectId: number,
  taskId: number,
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
        "Only owners and editors can delete tasks",
      );
    }

    const project = await findWorkspaceProject(workspaceId, projectId, tx);

    if (!project) {
      throw new AppError(404, "NOT_FOUND", "Project not found");
    }

    const task = await deleteWorkspaceTask(tx, projectId, taskId);

    if (!task) {
      throw new AppError(404, "NOT_FOUND", "Task not found");
    }

    return task;
  });
}
