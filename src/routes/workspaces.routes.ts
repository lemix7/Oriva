import { Router } from "express";
import {
  changeWorkspaceMemberRoleController,
  createWorkspaceController,
  getWorkspaceController,
  listWorkspaceMembersController,
  listWorkspacesController,
} from "../controllers/workspaces.controller.ts";
import { createWorkspaceValidator } from "../validators/workspaces.validator.ts";
import { listWorkspacesValidator } from "../validators/workspaces-list.validator.ts";
import validate from "../middleware/validate.ts";
import messageProvider from "../validators/message-provider.ts";
import { workspaceParamsValidator } from "../validators/workspaces-params.validator.ts";
import { workspaceMembersListValidator } from "../validators/workspace-members-list.validator.ts";
import { workspaceMemberParamsValidator } from "../validators/workspace-member-params.validator.ts";
import { workspaceMemberRoleValidator } from "../validators/workspace-member-role.validator.ts";

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

router.get(
  "/:wid/members",
  validate(workspaceParamsValidator, messageProvider, "params"),
  validate(workspaceMembersListValidator, messageProvider, "query"),
  listWorkspaceMembersController,
);

router.patch(
  "/:wid/members/:uid",
  validate(workspaceMemberParamsValidator, messageProvider, "params"),
  validate(workspaceMemberRoleValidator, messageProvider),
  changeWorkspaceMemberRoleController,
);

export default router;
