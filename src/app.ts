import "./config/env.ts";
import express, {
  type Response,
  type Request,
  type Express,
  response,
} from "express";
import errorHandling from "./middleware/error-handling.ts";
import looger from "./middleware/logger.ts";
import { login, authenticateJWT } from "./auth/auth-jwt.ts";
import {
  createUser,
  getMeController,
  updateMeController,
} from "./controllers/users.controller.ts";
import {
  createUserValidator,
  loginUserValidator,
} from "./validators/users.validator.ts";
import validate from "./middleware/validate.ts";
import messageProvider from "./validators/message-provider.ts";
import parseProfile from "./middleware/parse-profile.ts";
import requestId from "./middleware/request-id.ts";
import loginRateLimit from "./middleware/login-rate-limit.ts";
import workspaceRouter from "./routes/workspaces.routes.ts";
import invitationRouter from "./routes/invitations.routes.ts";
import { updateCurrentUserValidator } from "./validators/current-user-update.validator.ts";
import cookieParser from "cookie-parser";
import { requireTrustedOrigin } from "./middleware/trusted-origin.ts";
import {
  refreshSessionController,
  logoutSessionController,
} from "./controllers/auth-session.controller.ts";
import { changePasswordController } from "./controllers/password.controller.ts";
import { changePasswordValidator } from "./validators/password-change.validator.ts";
import passwordChangeRateLimit from "./middleware/password-change-rate-limit.ts";

const app: Express = express();

app.use(requestId);
app.use(looger);
app.use(express.json());
app.use(cookieParser());

// Public endpoints no token required
app.get("/", (req: Request, res: Response) => {
  res.status(200).json("Hello world");
});
app.post(
  "/login",
  loginRateLimit,
  requireTrustedOrigin,
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

app.post("/auth/refresh", requireTrustedOrigin, refreshSessionController);

app.post("/auth/logout", requireTrustedOrigin, logoutSessionController);

app.use(authenticateJWT);

// Protected endpoints
app.patch(
  "/me/password",
  validate(changePasswordValidator, messageProvider),
  passwordChangeRateLimit,
  changePasswordController,
);
app.get("/me", getMeController);
app.patch(
  "/me",
  validate(updateCurrentUserValidator, messageProvider),
  updateMeController,
);
app.use("/invitations", invitationRouter);
app.use("/workspaces", workspaceRouter);

app.use((_req, res) => {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: "Route not found",
      requestId: res.locals.requestId,
    },
  });
});

app.use(errorHandling);

export default app;
