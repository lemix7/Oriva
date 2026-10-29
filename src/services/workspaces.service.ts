import { db } from "../db/index.ts";
import {
  insertWorkspace,
  getWorkspacesByUserId,
  insertOwnerMembership,
  WORKSPACE_PAGE_SIZE,
} from "../repositories/workspace.repository.ts";


export async function createWorkspace(name: string, userId: number) {
  return db.transaction(async (tx) => {
    const workspace = await insertWorkspace(tx, name, userId);

    await insertOwnerMembership(tx, workspace.id, userId);

    return workspace;
  });
}

export async function listWorkspaces(userId: number, afterId: number) {
  const results = await getWorkspacesByUserId(userId, afterId);
  const hasNextPage = results.length > WORKSPACE_PAGE_SIZE;
  const data = hasNextPage ? results.slice(0, WORKSPACE_PAGE_SIZE) : results;

  return {
    data,
    nextCursor: hasNextPage ? data[data.length - 1].id : null,
  };
}