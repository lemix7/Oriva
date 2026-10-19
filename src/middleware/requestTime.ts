import { type Request, type Response, type NextFunction } from "express";

const requestTime = function (req: Request, res: Response, next: NextFunction) {
  const now = new Date()
  const formated = now.toLocaleString()
  req.requestTime = Date.now();
  next();
};

export default requestTime