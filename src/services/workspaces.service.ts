import { db } from "../db/index.ts";
import {
  insertWorkspace,
  insertOwnerMembership,
} from "../repositories/workspace.repository.ts";

export async function createWorkspace(name: string, userId: number) {
  return db.transaction(async (tx) => {
    const workspace = await insertWorkspace(tx, name, userId);

    await insertOwnerMembership(tx, workspace.id, userId);

    return workspace;
  });
}