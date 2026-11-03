import type { Request, Response } from "express";
import {
  createProjectStatus,
  editProjectStatus,
  listProjectStatuses,
  removeProjectStatus,
} from "../services/project-status.service.ts";
import { AppError } from "../shared/app-error.ts";

export async function listProjectStatusesController(
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
  const statuses = await listProjectStatuses(wid, pid, userId);

  return res.status(200).json({ data: statuses });
}

export async function createProjectStatusController(
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
  const { name, isDone } = res.locals.validatedData;

  const status = await createProjectStatus(wid, pid, actorId, {
    name,
    isDone,
  });

  return res.status(201).json({ data: status });
}

export async function editProjectStatusController(req: Request, res: Response) {
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

  const { wid, pid, sid } = res.locals.validatedParams;
  const { name, position, isDone } = res.locals.validatedData;

  const status = await editProjectStatus(wid, pid, sid, actorId, {
    name,
    position,
    isDone,
  });

  return res.status(200).json({ data: status });
}

export async function removeProjectStatusController(
    req: Request,
    res: Response,
  ) {
    const actorId =
      req.user && typeof req.user !== "string"
        ? req.user.userId
        : undefined;
  
    if (
      typeof actorId !== "number" ||
      !Number.isInteger(actorId) ||
      actorId <= 0 ||
      actorId > 2147483647
    ) {
      throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
    }
  
    const { wid, pid, sid } = res.locals.validatedParams;
  
    await removeProjectStatus(wid, pid, sid, actorId);
  
    return res.status(204).send();
  }