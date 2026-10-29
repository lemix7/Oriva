import { Router } from "express";
import {
  createWorkspaceController,
  listWorkspacesController,
} from "../controllers/workspaces.controller.ts";
import { createWorkspaceValidator } from "../validators/workspaces.validator.ts";
import { listWorkspacesValidator } from "../validators/workspaces-list.validator.ts";
import validate from "../middleware/validate.ts";
import messageProvider from "../validators/message-provider.ts";

const router = Router();

router.get(
  "/",
  validate(listWorkspacesValidator, messageProvider, "query"),
  listWorkspacesController,
);

router.post(
  "/",
  validate(createWorkspaceValidator, messageProvider),
  createWorkspaceController,
);

export default router;
