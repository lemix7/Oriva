import type { db } from "../db/index.ts";
import { invitations } from "../db/schema.ts";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type NewInvitation = {
  workspaceId: number;
  email: string;
  role: "editor" | "viewer";
  tokenHash: string;
  expiresAt: Date;
  invitedBy: number;
};

export async function insertInvitation(
  tx: Transaction,
  values: NewInvitation,
) {
  const [invitation] = await tx
    .insert(invitations)
    .values(values)
    .returning({
      id: invitations.id,
      workspaceId: invitations.workspaceId,
      email: invitations.email,
      role: invitations.role,
      expiresAt: invitations.expiresAt,
      invitedBy: invitations.invitedBy,
      createdAt: invitations.createdAt,
    });

  return invitation;
}