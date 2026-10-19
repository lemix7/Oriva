import { type Request, type Response, type NextFunction } from "express";

const looger = function (req: Request, res: Response, next: NextFunction) {
  console.log(`${req.method} ${req.originalUrl} - ${new Date().toISOString()}`);
  next();
};

export default looger;
