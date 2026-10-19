import { type Request, type Response, type NextFunction } from "express";
import { errors } from "@vinejs/vine";

class AppError extends Error {
  public statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
  }
}

const errorHandling = function (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof errors.E_VALIDATION_ERROR) {
    return res.status(422).json({
      success: false,
      message: "Validation failed",
      errors: err.messages,
    });
  }

  console.error(err.message);

  res.status(500).json({
    success: false,
    message: "Internal server error",
  });
};

export default errorHandling;
