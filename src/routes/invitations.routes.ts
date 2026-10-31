import { Router } from "express";
import { acceptInvitationController } from "../controllers/invitations.controller.ts";
import { acceptInvitationValidator } from "../validators/invitation-accept.validator.ts";
import validate from "../middleware/validate.ts";
import messageProvider from "../validators/message-provider.ts";

const router = Router();

router.post(
  "/accept",
  validate(acceptInvitationValidator, messageProvider),
  acceptInvitationController,
);

export default router;
