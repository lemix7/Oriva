import "./config/env.ts";
import express, {
  type Response,
  type Request,
  type Express,
  response,
} from "express";
import projectRouter from "./routes/project.routes.ts";
import taskRouter from "./routes/task.routes.ts";
import userRouter from "./routes/users.routes.ts";
import errorHandling from "./middleware/error-handling.ts";
import looger from "./middleware/logger.ts";
import { login, authenticateJWT } from "./auth/auth-jwt.ts";
import { createUser } from "./contollers/users.controller.ts";
import {
  createUserValidator,
  loginUserValidator,
} from "./validators/users.validator.ts";
import validate from "./middleware/validate.ts";
import messageProvider from "./validators/message-provider.ts";
import parseProfile from "./middleware/parse-profile.ts";
import requestId from "./middleware/request-id.ts";
import loginRateLimit from "./middleware/login-rate-limit.ts";

const app: Express = express();

app.use(requestId);
app.use(looger);
app.use(express.json());

// Public endpoints no token required
app.get("/", (req: Request, res: Response) => {
  res.status(200).json("Hello world");
});
app.use(
  "/login",
  loginRateLimit,
  validate(loginUserValidator, messageProvider),
  login,
);
app.post(
  "/users",
  parseProfile.single("profilePic"),
  validate(createUserValidator, messageProvider),
  createUser,
);

app.get("/error", (req: Request, res: Response) => {
  throw new Error("testing the error middleware");
});

app.use(authenticateJWT);

// Protected endpoints
app.use("/users/projects", projectRouter);
app.use("/projects", taskRouter);
app.use("/users", userRouter);

app.use(errorHandling);

export default app;
