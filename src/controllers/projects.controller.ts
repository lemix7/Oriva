import type { Request, Response } from "express";
import {
  createWorkspaceProject,
  editWorkspaceProject,
  getWorkspaceProject,
  listWorkspaceProjects,
  removeWorkspaceProject,
} from "../services/projects.service.ts";
import { AppError } from "../shared/app-error.ts";

export async function createWorkspaceProjectController(
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

  const { wid } = res.locals.validatedParams;
  const { name, description, status } = res.locals.validatedData;

  const project = await createWorkspaceProject(wid, actorId, {
    name,
    description,
    status,
  });

  return res.status(201).json({ data: project });
}

export async function listWorkspaceProjectsController(
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

  const { wid } = res.locals.validatedParams;
  const { afterId = 0 } = res.locals.validatedData;

  const result = await listWorkspaceProjects(wid, userId, afterId);

  return res.status(200).json({
    data: result.data,
    page: { nextCursor: result.nextCursor },
  });
}

export async function getWorkspaceProjectController(
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
  const project = await getWorkspaceProject(wid, pid, userId);

  return res.status(200).json({ data: project });
}

export async function editWorkspaceProjectController(
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
  const { name, description, status } = res.locals.validatedData;

  const project = await editWorkspaceProject(wid, pid, actorId, {
    name,
    description,
    status,
  });

  return res.status(200).json({ data: project });
}

export async function removeWorkspaceProjectController(
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

  await removeWorkspaceProject(wid, pid, actorId);

  return res.status(204).send();
}
