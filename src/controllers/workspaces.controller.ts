import type { Request, Response } from "express";
import {
  changeWorkspaceMemberRole,
  createWorkspace,
  getWorkspace,
  listWorkspaceMembers,
  listWorkspaces,
} from "../services/workspaces.service.ts";
import { AppError } from "../shared/app-error.ts";

export async function createWorkspaceController(req: Request, res: Response) {
  const userId =
    req.user && typeof req.user !== "string" ? req.user.userId : undefined;

  if (
    typeof userId !== "number" ||
    !Number.isInteger(userId) ||
    userId <= 0 ||
    userId > 2147483647
  ) {
    return res.status(401).json({
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication required",
        requestId: res.locals.requestId,
      },
    });
  }

  const { name } = res.locals.validatedData;
  const workspace = await createWorkspace(name, userId);

  return res.status(201).json({ data: workspace });
}

export async function listWorkspacesController(req: Request, res: Response) {
  const userId =
    req.user && typeof req.user !== "string" ? req.user.userId : undefined;

  if (
    typeof userId !== "number" ||
    !Number.isInteger(userId) ||
    userId <= 0 ||
    userId > 2147483647
  ) {
    return res.status(401).json({
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication required",
        requestId: res.locals.requestId,
      },
    });
  }

  const { afterId = 0 } = res.locals.validatedData;
  const result = await listWorkspaces(userId, afterId);

  return res.status(200).json({
    data: result.data,
    page: {
      nextCursor: result.nextCursor,
    },
  });
}

export async function getWorkspaceController(req: Request, res: Response) {
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

  const { wid } = res.locals.validatedData;
  const workspace = await getWorkspace(wid, userId);

  return res.status(200).json({ data: workspace });
}

export async function listWorkspaceMembersController(
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
  const { afterUserId = 0 } = res.locals.validatedData;

  const result = await listWorkspaceMembers(wid, userId, afterUserId);

  return res.status(200).json({
    data: result.data,
    page: { nextCursor: result.nextCursor },
  });
}

export async function changeWorkspaceMemberRoleController(
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

  const { wid, uid } = res.locals.validatedParams;
  const { role } = res.locals.validatedData;

  const member = await changeWorkspaceMemberRole(wid, actorId, uid, role);

  return res.status(200).json({ data: member });
}
