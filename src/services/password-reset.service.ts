import bcrypt from "bcryptjs";
import { db } from "../db/index.ts";
import {
  findPasswordResetTokenByHash,
  lockPasswordResetToken,
  invalidatePasswordResetToken,
} from "../repositories/password-reset-repository.ts";
import {
  lockAuthUser,
  revokeAllRefreshSessions,
} from "../repositories/refresh-session.repository.ts";
import { updateUserPassword } from "../repositories/user.repository.ts";
import { hashPasswordResetToken } from "../shared/password-reset-token.ts";
import { AppError } from "../shared/app-error.ts";
import emailQueue from "../queue/email.que.ts";
import { findUserByEmail } from "../repositories/user.repository.ts";
import { savePasswordResetToken } from "../repositories/password-reset-repository.ts";
import { generatePasswordResetToken } from "../shared/password-reset-token.ts";



export async function resetPassword(token: string, newPassword: string) {
  if (Buffer.byteLength(newPassword, "utf8") > 72) {
    throw new AppError(
      422,
      "PASSWORD_TOO_LONG",
      "New password must not exceed 72 UTF-8 bytes",
    );
  }

  const tokenHash = hashPasswordResetToken(token); // create a token hash
  const candidate = await findPasswordResetTokenByHash(tokenHash); //

  if (!candidate) {
    throw new AppError(
      400,
      "INVALID_RESET_TOKEN",
      "Reset link is invalid or expired",
    );
  }

  await db.transaction(async (tx) => {
    const user = await lockAuthUser(tx, candidate.userId);
    const resetToken = await lockPasswordResetToken(tx, tokenHash);
    const now = new Date();

    if (
      !user ||
      !resetToken ||
      resetToken.usedAt !== null ||
      resetToken.expiresAt <= now
    ) {
      throw new AppError(
        400,
        "INVALID_RESET_TOKEN",
        "Reset link is invalid or expired",
      );
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    const updated = await updateUserPassword(tx, user.id, passwordHash);

    if (!updated) {
      throw new Error("Password update returned no row");
    }

    await invalidatePasswordResetToken(tx, user.id, now);
    await revokeAllRefreshSessions(tx, user.id, now);
  });
}

const RESET_LIFETIME_MS = 15 * 60 * 1000;

// create the password reset link
export async function requestPasswordReset(email: string) {
  const candidate = await findUserByEmail(email);

  if (!candidate) {
    return;
  }

  const { token, tokenHash } = generatePasswordResetToken();

  const saved = await db.transaction(async (tx) => {
    const user = await lockAuthUser(tx, candidate.id);

    if (!user || user.email !== email) {
      return false;
    }

    await savePasswordResetToken(tx, {
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + RESET_LIFETIME_MS),
    });

    return true;
  });

  if (!saved) {
    return;
  }

  await emailQueue.add(
    "sendPasswordResetEmail",
    { email, token },
    {
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
}