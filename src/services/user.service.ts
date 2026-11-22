import { updateUserProfile } from "../repositories/user.repository.ts";
import { AppError } from "../shared/app-error.ts";
import { db } from "../db/index.ts";
import { lockAuthUser } from "../repositories/refresh-session.repository.ts";
import { invalidatePasswordResetToken } from "../repositories/password-reset-repository.ts";

export async function editCurrentUserProfile(
  userId: number,
  changes: {
    name?: string;
    email?: string;
  },
) {
  if (changes.name === undefined && changes.email === undefined) {
    throw new AppError(
      422,
      "EMPTY_UPDATE",
      "Provide at least one editable field",
    );
  }

  return db.transaction(async (tx) => {
    const currentUser = await lockAuthUser(tx, userId);

    if (!currentUser) {
      throw new AppError(404, "NOT_FOUND", "User not found");
    }

    const user = await updateUserProfile(userId, changes, tx);

    if (!user) {
      throw new AppError(404, "NOT_FOUND", "User not found");
    }

    if (changes.email !== undefined && changes.email !== currentUser.email) {
      await invalidatePasswordResetToken(tx, userId, new Date());
    }

    return user;
  });
}
