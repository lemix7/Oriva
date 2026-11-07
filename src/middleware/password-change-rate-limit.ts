import { rateLimit } from "express-rate-limit";

const passwordChangeRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const userId =
      req.user && typeof req.user !== "string" ? req.user.userId : undefined;

    return `password-change:${userId ?? "invalid"}`;
  },
  handler: (_req, res) => {
    res.status(429).json({
      error: {
        code: "RATE_LIMITED",
        message: "Too many password change attempts. Try again later.",
        requestId: res.locals.requestId,
      },
    });
  },
});

export default passwordChangeRateLimit;
