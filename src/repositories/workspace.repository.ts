import { workspaces, workspaceMembers } from "../db/schema.ts";
import { db } from "../db/index.ts";
import { and, asc, eq, gt } from "drizzle-orm";

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

export async function getWorkspacesByUserId(
  userId: number,
  afterId = 0,
) {
  return db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(
      workspaces,
      eq(workspaceMembers.workspaceId, workspaces.id),
    )
    .where(and(
      eq(workspaceMembers.userId, userId),
      gt(workspaces.id, afterId),
    ))
    .orderBy(asc(workspaces.id))
    .limit(WORKSPACE_PAGE_SIZE + 1);
}