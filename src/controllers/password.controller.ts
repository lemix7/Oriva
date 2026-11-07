import type { Request, Response } from "express";
import { changeCurrentUserPassword } from "../services/password.service.ts";
import { clearRefreshCookie } from "../auth/refresh-cookie.ts";
import { AppError } from "../shared/app-error.ts";

export async function changePasswordController(req: Request, res: Response) {
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

  const { currentPassword, newPassword } = res.locals.validatedData;

  await changeCurrentUserPassword(userId, currentPassword, newPassword);
  clearRefreshCookie(res);

  return res.status(204).send();
}
