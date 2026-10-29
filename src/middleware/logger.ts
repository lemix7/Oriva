import type { RequestHandler } from "express";

const logger: RequestHandler = (req, res, next) => {
  const startedAt = performance.now();
  const { method, path } = req;

  res.on("finish", () => {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      requestId: res.locals.requestId,
      method,
      path,
      status: res.statusCode,
      durationMs: Math.round(performance.now() - startedAt),
    }));
  });

  next();
};

export default logger;
