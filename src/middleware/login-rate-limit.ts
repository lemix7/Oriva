import { rateLimit } from "express-rate-limit";

const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      success: false,
      message: "Too many login attempts. Try again later.",
      requestId: res.locals.requestId,
    });
  },
});

export default loginRateLimit;