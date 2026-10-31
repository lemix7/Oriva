import { db } from "../db/index.ts";
import { invitations, users, workspaceMembers } from "../db/schema.ts";
import { and, eq, isNull, sql } from "drizzle-orm";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type NewInvitation = {
  workspaceId: number;
  email: string;
  role: "editor" | "viewer";
  tokenHash: string;
  expiresAt: Date;
  invitedBy: number;
};

export async function insertInvitation(tx: Transaction, values: NewInvitation) {
  const [invitation] = await tx.insert(invitations).values(values).returning({
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

export async function getInvitationByTokenHash(tokenHash: string) {
  const [invitation] = await db
    .select({
      id: invitations.id,
      workspaceId: invitations.workspaceId,
    })
    .from(invitations)
    .where(eq(invitations.tokenHash, tokenHash))
    .limit(1);

  return invitation;
}

export async function lockInvitation(
  tx: Transaction,
  workspaceId: number,
  invitationId: number,
) {
  const [invitation] = await tx
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.id, invitationId),
        eq(invitations.workspaceId, workspaceId),
      ),
    )
    .for("update");

  return invitation;
}

export async function getInvitationRecipient(
  tx: Transaction,
  userId: number,
) {
  const [user] = await tx
    .select({
      id: users.id,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return user;
} 

export async function insertInvitedMembership(
  tx: Transaction,
  workspaceId: number,
  userId: number,
  role: "editor" | "viewer",
) {
  const [membership] = await tx
    .insert(workspaceMembers)
    .values({
      workspaceId,
      userId,
      role,
    })
    .returning({
      workspaceId: workspaceMembers.workspaceId,
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
    });

  return membership;
}

export async function markInvitationAccepted(
  tx: Transaction,
  invitationId: number,
) {
  const now = new Date();

  const [invitation] = await tx
    .update(invitations)
    .set({
      acceptedAt: now,
      updatedAt: now,
    })
    .where(eq(invitations.id, invitationId))
    .returning({ id: invitations.id });

  return invitation;
}

export async function revokePendingInvitations(
  tx: Transaction,
  workspaceId: number,
  email: string,
) {
  const now = new Date();

  return tx
    .update(invitations)
    .set({
      revokedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(invitations.workspaceId, workspaceId),
        eq(invitations.email, email.trim().toLowerCase()),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    )
    .returning({ id: invitations.id });
}

export async function getWorkspaceMemberByEmail(
  tx: Transaction,
  workspaceId: number,
  email: string,
) {
  const [member] = await tx
    .select({
      userId: workspaceMembers.userId,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        sql`lower(trim(${users.email})) = ${email.trim().toLowerCase()}`,
      ),
    )
    .limit(1);

  return member;
}