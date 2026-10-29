import type { db } from "../db/index.ts";
import { workspaces, workspaceMembers } from "../db/schema.ts";

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