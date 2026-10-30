import { workspaces, workspaceMembers, users } from "../db/schema.ts";
import { db } from "../db/index.ts";
import { and, asc, eq, gt, ne } from "drizzle-orm";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function insertWorkspace(
  tx: Transaction,
  name: string,
  userId: number,
) {
  const [workspace] = await tx
    .insert(workspaces)
    .values({ name, createdBy: userId })
    .returning();

  return workspace;
}

export async function insertOwnerMembership(
  tx: Transaction,
  workspaceId: number,
  userId: number,
) {
  await tx.insert(workspaceMembers).values({
    workspaceId,
    userId,
    role: "owner",
  });
}

export const WORKSPACE_PAGE_SIZE = 20;

export async function getWorkspacesByUserId(userId: number, afterId = 0) {
  return db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaceMembers.userId, userId), gt(workspaces.id, afterId)))
    .orderBy(asc(workspaces.id))
    .limit(WORKSPACE_PAGE_SIZE + 1);
}

export async function getWorkspaceMembership(
  workspaceId: number,
  userId: number,
  tx?: Transaction,
) {
  const query = tx ?? db;
  const [membership] = await db
    .select({
      workspaceId: workspaceMembers.workspaceId,
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .limit(1);

  return membership;
}

export async function getWorkspaceById(workspaceId: number) {
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  return workspace;
}

export const MEMBER_PAGE_SIZE = 20;

export async function getWorkspaceMembers(
  workspaceId: number,
  afterUserId = 0,
) {
  return db
    .select({
      userId: workspaceMembers.userId,
      name: users.name,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        gt(workspaceMembers.userId, afterUserId),
      ),
    )
    .orderBy(asc(workspaceMembers.userId))
    .limit(MEMBER_PAGE_SIZE + 1);
}

export async function lockWorkspace(tx: Transaction, workspaceId: number) {
  const [workspace] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for("update");

  return workspace;
}

export async function updateWorkspaceMemberRole(
  tx: Transaction,
  workspaceId: number,
  userId: number,
  role: "editor" | "viewer",
) {
  const [member] = await tx
    .update(workspaceMembers)
    .set({
      role,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
        ne(workspaceMembers.role, "owner"),
      ),
    )
    .returning({
      workspaceId: workspaceMembers.workspaceId,
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
    });

  return member;
}