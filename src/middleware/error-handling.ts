import { type Request, type Response, type NextFunction } from "express";
import { errors } from "@vinejs/vine";
import { MulterError } from "multer";
import { AppError } from "../shared/app-error.ts";

const errorHandling = function (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (res.headersSent) {
    return next(err);
  }

  const requestId = res.locals.requestId;

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        requestId,
      },
    });
  }

  if (err instanceof MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      success: false,
      message: "Profile picture must be 5 MB or smaller",
      requestId,
    });
  }

  if (
    err instanceof SyntaxError &&
    "type" in err &&
    err.type === "entity.parse.failed"
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid JSON",
      requestId,
    });
  }

  if (err instanceof errors.E_VALIDATION_ERROR) {
    return res.status(422).json({
      success: false,
      message: "Validation failed",
      errors: err.messages,
      requestId,
    });
  }

  console.error(
    JSON.stringify({
      level: "error",
      requestId,
      error: err.name,
      status: 500,
    }),
  );

  res.status(500).json({
    success: false,
    message: "Internal server error",
    requestId,
  });
};

export default errorHandling;
