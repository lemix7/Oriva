import { updateUserProfile } from "../repositories/user.repository.ts";
import { AppError } from "../shared/app-error.ts";

export async function editCurrentUserProfile(
  userId: number,
  changes: {
    name?: string;
    email?: string;
  },
) {
  if (
    changes.name === undefined &&
    changes.email === undefined
  ) {
    throw new AppError(
      422,
      "EMPTY_UPDATE",
      "Provide at least one editable field",
    );
  }

  const user = await updateUserProfile(userId, changes);

  if (!user) {
    throw new AppError(404, "NOT_FOUND", "User not found");
  }

  return user;
}