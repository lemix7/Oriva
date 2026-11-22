import type { Request, Response } from "express";
import emailQueue from "../queue/email.que.ts";
import { resetPassword } from "../services/password-reset.service.ts";
import { clearRefreshCookie } from "../auth/refresh-cookie.ts";

export async function forgotPasswordController(
  _req: Request,
  res: Response,
) {
  const { email } = res.locals.validatedData;

  await emailQueue.add(
    "requestPasswordReset",
    { email },
    {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    },
  );

  res.set("Cache-Control", "no-store");

  return res.status(202).json({
    message:
      "If an account exists with that email, we’ll send a password-reset link.",
  });
}

export async function resetPasswordController(
  _req: Request,
  res: Response,
) {
  const { token, newPassword } = res.locals.validatedData;

  await resetPassword(token, newPassword);
  clearRefreshCookie(res);

  return res.status(204).send();
}