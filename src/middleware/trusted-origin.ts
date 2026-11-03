import type { Request, Response, NextFunction } from "express";
import { requiredEnv } from "../config/env.ts";
import { AppError } from "../shared/app-error.ts";

const configuredOrigin = new URL(requiredEnv("APP_ORIGIN"));

if (!["http:", "https:"].includes(configuredOrigin.protocol)) {
  throw new Error("APP_ORIGIN must be an HTTP(S) URL");
}

const allowedOrigin = configuredOrigin.origin;

export function requireTrustedOrigin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  res.set("Cache-Control", "no-store");

  if (req.get("Origin") !== allowedOrigin) {
    throw new AppError(
      403,
      "UNTRUSTED_ORIGIN",
      "Request origin is not allowed",
    );
  }

  next();
}
