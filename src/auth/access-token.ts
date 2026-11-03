import jwt from "jsonwebtoken";
import { requiredEnv } from "../config/env.ts";

const SECRET_KEY = requiredEnv("SECRET_KEY");

export function createAccessToken(userId: number): string {
  return jwt.sign({ userId }, SECRET_KEY, {
    expiresIn: "15m",
    algorithm: "HS256",
  });
}