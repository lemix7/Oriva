import { Router } from "express";
import { createWorkspaceController } from "../controllers/workspaces.controller.ts";
import { createWorkspaceValidator } from "../validators/workspaces.validator.ts";
import validate from "../middleware/validate.ts";
import messageProvider from "../validators/message-provider.ts";

const router = Router();

router.post(
  "/",
  validate(createWorkspaceValidator, messageProvider),
  createWorkspaceController,
);

export default router;
