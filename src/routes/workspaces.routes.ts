import { Router } from "express";
import {
  changeWorkspaceMemberRoleController,
  createWorkspaceController,
  getWorkspaceController,
  listWorkspaceMembersController,
  listWorkspacesController,
  removeWorkspaceMemberController,
  transferWorkspaceOwnershipController,
} from "../controllers/workspaces.controller.ts";
import { createWorkspaceValidator } from "../validators/workspaces.validator.ts";
import { listWorkspacesValidator } from "../validators/workspaces-list.validator.ts";
import validate from "../middleware/validate.ts";
import messageProvider from "../validators/message-provider.ts";
import { workspaceParamsValidator } from "../validators/workspaces-params.validator.ts";
import { workspaceMembersListValidator } from "../validators/workspace-members-list.validator.ts";
import { workspaceMemberParamsValidator } from "../validators/workspace-member-params.validator.ts";
import { workspaceMemberRoleValidator } from "../validators/workspace-member-role.validator.ts";
import { workspaceOwnershipTransferValidator } from "../validators/workspace-ownership-transfer.validator.ts";
import { createInvitationValidator } from "../validators/invitations.validator.ts";
import {
  createInvitationController,
  listInvitationsController,
  revokeInvitationController,
} from "../controllers/invitations.controller.ts";
import { listInvitationsValidator } from "../validators/invitation-list.validator.ts";
import { invitationParamsValidator } from "../validators/invitation-params.validator.ts";
import {
  createWorkspaceProjectController,
  editWorkspaceProjectController,
  getWorkspaceProjectController,
  listWorkspaceProjectsController,
  removeWorkspaceProjectController,
} from "../controllers/projects.controller.ts";
import createProjectValidator from "../validators/projects.validator.ts";
import { listProjectsValidator } from "../validators/project-list.validator.ts";
import { workspaceProjectParamsValidator } from "../validators/workspace-project-params.validator.ts";
import { updateProjectValidator } from "../validators/project-update.validator.ts";
import { listTasksValidator } from "../validators/task-list.validator.ts";
import {
  createWorkspaceTaskController,
  editWorkspaceTaskController,
  getWorkspaceTaskController,
  listWorkspaceTasksController,
  removeWorkspaceTaskController,
} from "../controllers/tasks.controller.ts";
import { workspaceTaskParamsValidator } from "../validators/workspace-task-params.validator.ts";
import { createWorkspaceTaskValidator } from "../validators/workspace-task-create-validator.ts";
import { updateWorkspaceTaskValidator } from "../validators/workspace-task-update.validator.ts";
import {
  createProjectStatusController,
  editProjectStatusController,
  listProjectStatusesController,
  removeProjectStatusController,
} from "../controllers/project-status-controller.ts";
import { createProjectStatusValidator } from "../validators/project-status-create.validator.ts";
import { updateProjectStatusValidator } from "../validators/project-status-update.validator.ts";
import { workspaceProjectStatusParamsValidator } from "../validators/workspace-project-status-params.validator.ts";

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

router.delete(
  "/:wid/members/:uid",
  validate(workspaceMemberParamsValidator, messageProvider, "params"),
  removeWorkspaceMemberController,
);

router.post(
  "/:wid/ownership-transfer",
  validate(workspaceParamsValidator, messageProvider, "params"),
  validate(workspaceOwnershipTransferValidator, messageProvider),
  transferWorkspaceOwnershipController,
);

router.post(
  "/:wid/invitations",
  validate(workspaceParamsValidator, messageProvider, "params"),
  validate(createInvitationValidator, messageProvider),
  createInvitationController,
);

router.get(
  "/:wid/invitations",
  validate(workspaceParamsValidator, messageProvider, "params"),
  validate(listInvitationsValidator, messageProvider, "query"),
  listInvitationsController,
);

router.delete(
  "/:wid/invitations/:iid",
  validate(invitationParamsValidator, messageProvider, "params"),
  revokeInvitationController,
);

router.post(
  "/:wid/projects",
  validate(workspaceParamsValidator, messageProvider, "params"),
  validate(createProjectValidator, messageProvider),
  createWorkspaceProjectController,
);

router.get(
  "/:wid/projects",
  validate(workspaceParamsValidator, messageProvider, "params"),
  validate(listProjectsValidator, messageProvider, "query"),
  listWorkspaceProjectsController,
);

router.get(
  "/:wid/projects/:pid",
  validate(workspaceProjectParamsValidator, messageProvider, "params"),
  getWorkspaceProjectController,
);

router.patch(
  "/:wid/projects/:pid",
  validate(workspaceProjectParamsValidator, messageProvider, "params"),
  validate(updateProjectValidator, messageProvider),
  editWorkspaceProjectController,
);

router.delete(
  "/:wid/projects/:pid",
  validate(workspaceProjectParamsValidator, messageProvider, "params"),
  removeWorkspaceProjectController,
);

router.get(
  "/:wid/projects/:pid/tasks",
  validate(workspaceProjectParamsValidator, messageProvider, "params"),
  validate(listTasksValidator, messageProvider, "query"),
  listWorkspaceTasksController,
);

router.get(
  "/:wid/projects/:pid/tasks/:tid",
  validate(workspaceTaskParamsValidator, messageProvider, "params"),
  getWorkspaceTaskController,
);

router.post(
  "/:wid/projects/:pid/tasks",
  validate(workspaceProjectParamsValidator, messageProvider, "params"),
  validate(createWorkspaceTaskValidator, messageProvider),
  createWorkspaceTaskController,
);

router.patch(
  "/:wid/projects/:pid/tasks/:tid",
  validate(workspaceTaskParamsValidator, messageProvider, "params"),
  validate(updateWorkspaceTaskValidator, messageProvider),
  editWorkspaceTaskController,
);

router.delete(
  "/:wid/projects/:pid/tasks/:tid",
  validate(workspaceTaskParamsValidator, messageProvider, "params"),
  removeWorkspaceTaskController,
);

router.get(
  "/:wid/projects/:pid/statuses",
  validate(workspaceProjectParamsValidator, messageProvider, "params"),
  listProjectStatusesController,
);

router.post(
  "/:wid/projects/:pid/statuses",
  validate(workspaceProjectParamsValidator, messageProvider, "params"),
  validate(createProjectStatusValidator, messageProvider),
  createProjectStatusController,
);

router.patch(
  "/:wid/projects/:pid/statuses/:sid",
  validate(workspaceProjectStatusParamsValidator, messageProvider, "params"),
  validate(updateProjectStatusValidator, messageProvider),
  editProjectStatusController,
);

router.delete(
  "/:wid/projects/:pid/statuses/:sid",
  validate(workspaceProjectStatusParamsValidator, messageProvider, "params"),
  removeProjectStatusController,
);

export default router;
