import { db } from "../db/index.ts";
import { projects, tasks } from "../db/schema.ts";
import { and, asc, eq, gt } from "drizzle-orm";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function insertWorkspaceProject(
  tx: Transaction,
  workspaceId: number,
  creatorId: number,
  input: {
    name: string;
    description?: string;
    status: string;
  },
) {
  const [project] = await tx
    .insert(projects)
    .values({
      workspaceId,
      userId: creatorId,
      name: input.name,
      description: input.description,
      status: input.status,
    })
    .returning({
      id: projects.id,
      workspaceId: projects.workspaceId,
      createdBy: projects.userId,
      name: projects.name,
      description: projects.description,
      status: projects.status,
      createdAt: projects.createdAt,
    });

  return project;
}

export const PROJECT_PAGE_SIZE = 20;

export async function getWorkspaceProjects(workspaceId: number, afterId = 0) {
  return db
    .select({
      id: projects.id,
      workspaceId: projects.workspaceId,
      createdBy: projects.userId,
      name: projects.name,
      description: projects.description,
      status: projects.status,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), gt(projects.id, afterId)))
    .orderBy(asc(projects.id))
    .limit(PROJECT_PAGE_SIZE + 1);
}

export async function findWorkspaceProject(
  workspaceId: number,
  projectId: number,
  tx?: Transaction,
) {
  const query = tx ?? db;

  const [project] = await query
    .select({
      id: projects.id,
      workspaceId: projects.workspaceId,
      createdBy: projects.userId,
      name: projects.name,
      description: projects.description,
      status: projects.status,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .where(
      and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId)),
    )
    .limit(1);

  return project;
}

export async function updateWorkspaceProject(
  tx: Transaction,
  workspaceId: number,
  projectId: number,
  changes: {
    name?: string;
    description?: string | null;
    status?: string;
  },
) {
  const [project] = await tx
    .update(projects)
    .set(changes)
    .where(
      and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId)),
    )
    .returning({
      id: projects.id,
      workspaceId: projects.workspaceId,
      createdBy: projects.userId,
      name: projects.name,
      description: projects.description,
      status: projects.status,
      createdAt: projects.createdAt,
    });

  return project;
}

export async function deleteWorkspaceProject(
  tx: Transaction,
  workspaceId: number,
  projectId: number,
) {
  const [project] = await tx
    .delete(projects)
    .where(
      and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId)),
    )
    .returning({
      id: projects.id,
      workspaceId: projects.workspaceId,
    });

  return project;
}

export async function projectHasTasks(tx: Transaction, projectId: number) {
  const [task] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .limit(1);

  return task !== undefined;
}
