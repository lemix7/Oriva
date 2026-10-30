import { Router } from "express";
import {
  createWorkspaceController,
  getWorkspaceController,
  listWorkspacesController,
} from "../controllers/workspaces.controller.ts";
import { createWorkspaceValidator } from "../validators/workspaces.validator.ts";
import { listWorkspacesValidator } from "../validators/workspaces-list.validator.ts";
import validate from "../middleware/validate.ts";
import messageProvider from "../validators/message-provider.ts";
import { workspaceParamsValidator } from "../validators/workspaces-params.validator.ts";

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

router.get(
  "/:wid",
  validate(workspaceParamsValidator, messageProvider, "params"),
  getWorkspaceController,
);

export default router;
