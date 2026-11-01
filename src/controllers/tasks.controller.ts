import type { Request, Response } from "express";
import { AppError } from "../shared/app-error.ts";
import {
  createWorkspaceTask,
  editWorkspaceTask,
  getWorkspaceTask,
  listWorkspaceTasks,
  removeWorkspaceTask,
} from "../services/tasks.service.ts";

export async function listWorkspaceTasksController(
  req: Request,
  res: Response,
) {
  const userId =
    req.user && typeof req.user !== "string" ? req.user.userId : undefined;

  if (
    typeof userId !== "number" ||
    !Number.isInteger(userId) ||
    userId <= 0 ||
    userId > 2147483647
  ) {
    throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
  }

  const { wid, pid } = res.locals.validatedParams;
  const { afterId = 0 } = res.locals.validatedData;

  const result = await listWorkspaceTasks(wid, pid, userId, afterId);

  return res.status(200).json({
    data: result.data,
    page: { nextCursor: result.nextCursor },
  });
}

export async function getWorkspaceTaskController(req: Request, res: Response) {
  const userId =
    req.user && typeof req.user !== "string" ? req.user.userId : undefined;

  if (
    typeof userId !== "number" ||
    !Number.isInteger(userId) ||
    userId <= 0 ||
    userId > 2147483647
  ) {
    throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
  }

  const { wid, pid, tid } = res.locals.validatedParams;
  const task = await getWorkspaceTask(wid, pid, tid, userId);

  return res.status(200).json({ data: task });
}

export async function createWorkspaceTaskController(
  req: Request,
  res: Response,
) {
  const actorId =
    req.user && typeof req.user !== "string" ? req.user.userId : undefined;

  if (
    typeof actorId !== "number" ||
    !Number.isInteger(actorId) ||
    actorId <= 0 ||
    actorId > 2147483647
  ) {
    throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
  }

  const { wid, pid } = res.locals.validatedParams;
  const { title, description, status } = res.locals.validatedData;

  const task = await createWorkspaceTask(wid, pid, actorId, {
    title,
    description,
    status,
  });

  return res.status(201).json({ data: task });
}

export async function editWorkspaceTaskController(req: Request, res: Response) {
  const actorId =
    req.user && typeof req.user !== "string" ? req.user.userId : undefined;

  if (
    typeof actorId !== "number" ||
    !Number.isInteger(actorId) ||
    actorId <= 0 ||
    actorId > 2147483647
  ) {
    throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
  }

  const { wid, pid, tid } = res.locals.validatedParams;
  const { title, description, status } = res.locals.validatedData;

  const task = await editWorkspaceTask(wid, pid, tid, actorId, {
    title,
    description,
    status,
  });

  return res.status(200).json({ data: task });
}

export async function removeWorkspaceTaskController(
  req: Request,
  res: Response,
) {
  const actorId =
    req.user && typeof req.user !== "string" ? req.user.userId : undefined;

  if (
    typeof actorId !== "number" ||
    !Number.isInteger(actorId) ||
    actorId <= 0 ||
    actorId > 2147483647
  ) {
    throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
  }

  const { wid, pid, tid } = res.locals.validatedParams;

  await removeWorkspaceTask(wid, pid, tid, actorId);

  return res.status(204).send();
}
