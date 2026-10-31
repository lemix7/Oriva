import { db } from "../db/index.ts";
import {
  lockWorkspace,
  getWorkspaceMembership,
} from "../repositories/workspace.repository.ts";

import { generateInvitationToken } from "../shared/invitation-token.ts";
import { AppError } from "../shared/app-error.ts";
import { insertInvitation } from "../repositories/invitations.repository.ts";

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
