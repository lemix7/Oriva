import type { Request, Response } from "express";
import { createWorkspaceInvitation } from "../services/invitations.service.ts";
import { queueInvitationEmail } from "../services/invitation-delivery.service.ts";
import { AppError } from "../shared/app-error.ts";

export async function createInvitationController(
  req: Request,
  res: Response,
) {
  const actorId =
    req.user && typeof req.user !== "string"
      ? req.user.userId
      : undefined;

  if (
    typeof actorId !== "number" ||
    !Number.isInteger(actorId) ||
    actorId <= 0 ||
    actorId > 2147483647
  ) {
    throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
  }

  const { wid } = res.locals.validatedParams;
  const { email, role } = res.locals.validatedData;

  const { invitation, token } = await createWorkspaceInvitation(
    wid,
    actorId,
    email,
    role,
  );

  try {
    await queueInvitationEmail(
      invitation.id,
      invitation.email,
      token,
    );
  } catch {
    throw new AppError(
      503,
      "INVITATION_EMAIL_QUEUE_FAILED",
      "Invitation was saved, but its email could not be queued",
    );
  }

  return res.status(201).json({ data: invitation });
}