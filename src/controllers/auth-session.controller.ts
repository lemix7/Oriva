import type { Request, Response } from "express";
import {
  rotateRefreshSession,
  logoutSession,
} from "../services/auth-session.service.ts";
import {
  readRefreshCookie,
  setRefreshCookie,
  clearRefreshCookie,
} from "../auth/refresh-cookie.ts";
import { AppError } from "../shared/app-error.ts";

export async function refreshSessionController(req: Request, res: Response) {
  const token = readRefreshCookie(req);

  if (!token) {
    clearRefreshCookie(res);
    throw new AppError(401, "INVALID_REFRESH_TOKEN", "Please sign in again");
  }

  try {
    const tokens = await rotateRefreshSession(token);

    setRefreshCookie(res, tokens.refreshToken, tokens.refreshExpiresAt);

    return res.status(200).json({ token: tokens.accessToken });
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 401) {
      clearRefreshCookie(res);
    }

    throw error;
  }
}

export async function logoutSessionController(req: Request, res: Response) {
  await logoutSession(readRefreshCookie(req));
  clearRefreshCookie(res);

  return res.status(204).send();
}
