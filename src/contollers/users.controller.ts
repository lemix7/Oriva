import express, { type Response, type Request, type Express } from "express";
import * as userRepository from "../repositories/user.repository.ts";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import emailQueue from "../queue/email.que.ts";
import "../workers/email.worker.ts";
import {
  uploadProfilePicture,
  deleteProfilePicture,
} from "../adapters/profile-pic-storage.adapter.ts";

dotenv.config();

const getUsers = async (req: Request, res: Response) => {
  const users = await userRepository.findAllUsers();
  res.status(200).json(users);
};

const getUserById = async (req: Request, res: Response) => {
  const id = Number(req.params.user_id);
  const users = await userRepository.findUsersById(id);
  res.status(200).json(users);
};

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

const updateUser = async (req: Request, res: Response) => {
  const id = Number(req.params.user_id);
  const { name, email } = req.body;
  const updated = await userRepository.updateUser(name, email, id);
  if (!updated) {
    return res.status(404).json({ message: "User not found" });
  }
  res.status(200).send(`User modified with ID: ${id}`);
};

const deleteUser = async (req: Request, res: Response) => {
  const id = Number(req.params.user_id);
  await userRepository.deleteUser(id);
  res.status(200).send(`User deleted with ID: ${id}`);
};

export { getUsers, getUserById, createUser, updateUser, deleteUser };
