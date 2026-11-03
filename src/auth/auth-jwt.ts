import jwt from "jsonwebtoken";
import { type NextFunction, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { requiredEnv } from "../config/env.ts";
import { loginUserSchema } from "../validators/users.validator.ts";
import vine from "@vinejs/vine";
import { createLoginSession } from "../services/auth-session.service.ts";
import { setRefreshCookie } from "./refresh-cookie.ts";
import { findUserByEmail } from "../repositories/user.repository.ts";

const SECRET_KEY = requiredEnv("SECRET_KEY");

const login = async (req: Request, res: Response) => {
  const validator = vine.compile(loginUserSchema);
  const { email, password } = await validator.validate(req.body);

  const user = await findUserByEmail(email);

  if (!user) {
    return res.status(401).send("Invalid credentials");
  }

  const validPassword = await bcrypt.compare(password, user.password);

  if (!validPassword) {
    return res.status(401).send("Invalid credentials");
  }

  const tokens = await createLoginSession(user.id, user.password);

  setRefreshCookie(res, tokens.refreshToken, tokens.refreshExpiresAt);

  return res.status(200).json({
    message: "Login successfull",
    token: tokens.accessToken,
  });
};

const authenticateJWT = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : undefined;

  if (token) {
    jwt.verify(token, SECRET_KEY, { algorithms: ["HS256"] }, (err, user) => {
      if (err) {
        return res.status(401).send("Invalid token");
      }

      req.user = user;
      next();
    });
  } else {
    res.status(401).send("Token required");
  }
};

export { login, authenticateJWT };
