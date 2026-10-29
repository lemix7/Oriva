import type { Request, Response } from "express";
import { createWorkspace } from "../services/workspaces.service.ts";


export async function createWorkspaceController(
  req: Request,
  res: Response,
) {
  const userId =
    req.user && typeof req.user !== "string"
      ? req.user.userId
      : undefined;

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