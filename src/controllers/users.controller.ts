import type { Request, Response } from "express";
import * as userRepository from "../repositories/user.repository.ts";
import bcrypt from "bcryptjs";
import emailQueue from "../queue/email.que.ts";
import {
  uploadProfilePicture,
  deleteProfilePicture,
} from "../adapters/profile-pic-storage.adapter.ts";
import { AppError } from "../shared/app-error.ts";
import { editCurrentUserProfile } from "../services/user.service.ts";

const createUser = async (req: Request, res: Response) => {
  const { name, email, password } = res.locals.validatedData;
  const pass = await bcrypt.hash(password, 8);

  let key: string | null = null;
  let user;

  try {
    if (req.file) {
      key = await uploadProfilePicture(req.file);
    }

    user = await userRepository.insertUser(name, email, pass, key);
  } catch (error) {
    if (key) {
      try {
        await deleteProfilePicture(key);
      } catch (cleanupError) {
        console.error("Could not clean up uploaded image:", cleanupError);
      }
    }

    throw error;
  }

  try {
    await emailQueue.add("sendEmail", { user_name: user.name });
  } catch (error) {
    console.error("User created, but notification could not be queued:", error);
  }

  return res.status(201).json({
    message: "User created successfully",
    id: user.id,
  });
};

export async function getMeController(req: Request, res: Response) {
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

  const user = await userRepository.findUserProfileById(userId);

  if (!user) {
    throw new AppError(404, "NOT_FOUND", "User not found");
  }

  return res.status(200).json({ data: user });
}

export async function updateMeController(req: Request, res: Response) {
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

  const { name, email } = res.locals.validatedData;

  const user = await editCurrentUserProfile(userId, {
    name,
    email,
  });

  return res.status(200).json({ data: user });
}

export { createUser };
