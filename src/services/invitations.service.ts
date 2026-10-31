import { db } from "../db/index.ts";
import {
  lockWorkspace,
  getWorkspaceMembership,
} from "../repositories/workspace.repository.ts";

import {
  generateInvitationToken,
  hashInvitationToken,
} from "../shared/invitation-token.ts";
import { AppError } from "../shared/app-error.ts";
import {
  getInvitationByTokenHash,
  getInvitationRecipient,
  getWorkspaceMemberByEmail,
  insertInvitation,
  insertInvitedMembership,
  lockInvitation,
  markInvitationAccepted,
  revokePendingInvitations,
} from "../repositories/invitations.repository.ts";

export async function createWorkspaceInvitation(
  workspaceId: number,
  actorId: number,
  email: string,
  role: "editor" | "viewer",
) {
  return db.transaction(async (tx) => {
    const workspace = await lockWorkspace(tx, workspaceId);
    const actor = await getWorkspaceMembership(workspaceId, actorId, tx);

    if (!workspace || !actor) {
      throw new AppError(404, "NOT_FOUND", "Workspace not found");
    }

    if (actor.role !== "owner") {
      throw new AppError(403, "FORBIDDEN", "Only owners can invite members");
    }

    const existingMember = await getWorkspaceMemberByEmail(
      tx,
      workspaceId,
      email,
    );

    if (existingMember) {
      throw new AppError(
        409,
        "ALREADY_MEMBER",
        "This user already belongs to the workspace",
      );
    }

    const { token, tokenHash } = generateInvitationToken();

    const invitation = await insertInvitation(tx, {
      workspaceId,
      email: email.trim().toLowerCase(),
      role,
      tokenHash,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      invitedBy: actorId,
    });

    if (!invitation) {
      throw new Error("Invitation insert returned no row");
    }

    return { invitation, token };
  });
}

export async function acceptWorkspaceInvitation(token: string, userId: number) {
  const found = await getInvitationByTokenHash(hashInvitationToken(token));

  if (!found) {
    throw new AppError(404, "NOT_FOUND", "Invitation not found");
  }

  const result = await db.transaction(async (tx) => {
    const workspace = await lockWorkspace(tx, found.workspaceId);
    const invitation = await lockInvitation(tx, found.workspaceId, found.id);

    if (!workspace || !invitation) {
      throw new AppError(404, "NOT_FOUND", "Invitation not found");
    }

    const user = await getInvitationRecipient(tx, userId);

    if (!user?.email || user.email.trim().toLowerCase() !== invitation.email) {
      throw new AppError(
        403,
        "INVITATION_EMAIL_MISMATCH",
        "Sign in with the invited email address",
      );
    }

    if (
      invitation.acceptedAt ||
      invitation.revokedAt ||
      invitation.expiresAt.getTime() <= Date.now()
    ) {
      throw new AppError(
        409,
        "INVITATION_UNAVAILABLE",
        "Invitation is already used, revoked, or expired",
      );
    }

    const existing = await getWorkspaceMembership(
      invitation.workspaceId,
      userId,
      tx,
    );

    if (existing) {
      await revokePendingInvitations(
        tx,
        invitation.workspaceId,
        invitation.email,
      );

      return { kind: "already-member" as const };
    }

    const membership = await insertInvitedMembership(
      tx,
      invitation.workspaceId,
      userId,
      invitation.role,
    );

    const accepted = await markInvitationAccepted(tx, invitation.id);

    if (!membership || !accepted) {
      throw new Error("Invitation acceptance did not complete");
    }

    await revokePendingInvitations(
      tx,
      invitation.workspaceId,
      invitation.email,
    );

    return { kind: "accepted" as const, membership };
  });

  if (result.kind === "already-member") {
    throw new AppError(
      409,
      "ALREADY_MEMBER",
      "You already belong to this workspace",
    );
  }

  return result.membership;
}
