import jwt from "jsonwebtoken";
import { type NextFunction, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { requiredEnv } from "../config/env.ts";
import { loginUserSchema } from "../validators/users.validator.ts";
import vine, { errors } from "@vinejs/vine";
import { findUserByEmail } from "../repositories/user.repository.ts";

const SECRET_KEY = requiredEnv("SECRET_KEY");

const login = async (req: Request, res: Response) => {
  const { email, password } = req.body;

  try {
    const validator = vine.compile(loginUserSchema);
    const output = await validator.validate(req.body);

    const user = await findUserByEmail(email);

    if (!user) {
      return res.status(401).send("Invalid credentials");
    }

    const isValid = await bcrypt.compare(password, user.password);

    if (!isValid) {
      return res.status(401).send("Invalid credentials");
    }

    const token = jwt.sign({ userId: user.id }, SECRET_KEY, {
      expiresIn: "1h",
      algorithm: "HS256",
    });

    if (!token) {
      throw new Error("falied to create a token");
    }

    res.status(200).send({
      message: "Login successfull",
      token: token,
    });
  } catch (error) {
    if (error instanceof errors.E_VALIDATION_ERROR) {
      res.status(error.status).send(error.message);
    }
    throw error;
  }
};

const authenticateJWT = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer")
    ? authHeader.slice(7)
    : undefined;

  if (token) {
    jwt.verify(token, SECRET_KEY, (err, user) => {
      if (err) {
        return res.status(403).send("Invalid token");
      }
      req.user = user;
      next();
    });
  } else {
    res.status(401).send("Token required");
  }
};

export { login, authenticateJWT };
