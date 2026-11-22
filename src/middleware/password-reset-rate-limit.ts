import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { rateLimit } from "express-rate-limit";

const options = {
  windowMs: 15 * 60 * 1000, // 15 min
  standardHeaders: "draft-8" as const,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => { // what to return after limit is exceded
    res.status(429).json({
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests. Try again later.",
        requestId: res.locals.requestId,
      },
    });
  },
};

// Protects the link generation by ip
export const forgotPasswordIpLimit = rateLimit({
  ...options,
  limit: 10,
});

// Protects the link generation by email
export const forgotPasswordEmailLimit = rateLimit({
  ...options,
  limit: 3,
  keyGenerator: (_req, res) =>
    createHash("sha256").update(res.locals.validatedData.email).digest("hex"),
});

// Protect the reset submission by ip
export const resetPasswordLimit = rateLimit({
  ...options,
  limit: 10,
});
