import bcrypt from "bcryptjs";
import { db } from "../db/index.ts";
import {
  lockAuthUser,
  revokeAllRefreshSessions,
} from "../repositories/refresh-session.repository.ts";
import { updateUserPassword } from "../repositories/user.repository.ts";
import { AppError } from "../shared/app-error.ts";

export async function changeCurrentUserPassword(
  userId: number,
  currentPassword: string,
  newPassword: string,
) {
  // bcrypt's limit is bytes, not characters.
  if (Buffer.byteLength(newPassword, "utf8") > 72) {
    throw new AppError(
      422,
      "PASSWORD_TOO_LONG",
      "New password must not exceed 72 UTF-8 bytes",
    );
  }

  await db.transaction(async (tx) => {
    const user = await lockAuthUser(tx, userId);

    if (!user) {
      throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
    }

    const valid = await bcrypt.compare(currentPassword, user.password);

    if (!valid) {
      throw new AppError(
        422,
        "INVALID_CURRENT_PASSWORD",
        "Current password is incorrect",
      );
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    const updated = await updateUserPassword(tx, userId, passwordHash);

    if (!updated) {
      throw new Error("Password update returned no row");
    }

    await revokeAllRefreshSessions(tx, userId, new Date());
  });
}
