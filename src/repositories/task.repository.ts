import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "../db/index.ts";
import { projects, tasks } from "../db/schema.ts";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const TASK_PAGE_SIZE = 20;

export async function getWorkspaceTasks(
  workspaceId: number,
  projectId: number,
  afterId = 0,
) {
  return db
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(
        eq(projects.workspaceId, workspaceId),
        eq(tasks.projectId, projectId),
        gt(tasks.id, afterId),
      ),
    )
    .orderBy(asc(tasks.id))
    .limit(TASK_PAGE_SIZE + 1);
}

export async function findWorkspaceTask(
  workspaceId: number,
  projectId: number,
  taskId: number,
) {
  const [task] = await db
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(
        eq(projects.workspaceId, workspaceId),
        eq(tasks.projectId, projectId),
        eq(tasks.id, taskId),
      ),
    )
    .limit(1);

  return task;
}

export async function insertWorkspaceTask(
  tx: Transaction,
  projectId: number,
  input: {
    title: string;
    description?: string;
    status: "done" | "cancelled" | "on progress";
  },
) {
  const [task] = await tx
    .insert(tasks)
    .values({
      projectId,
      title: input.title,
      description: input.description,
      status: input.status,
    })
    .returning({
      id: tasks.id,
      projectId: tasks.projectId,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      createdAt: tasks.createdAt,
    });

  return task;
}

export async function updateWorkspaceTask(
  tx: Transaction,
  projectId: number,
  taskId: number,
  changes: {
    title?: string;
    description?: string | null;
    status?: "done" | "cancelled" | "on progress";
  },
) {
  const [task] = await tx
    .update(tasks)
    .set(changes)
    .where(
      and(
        eq(tasks.projectId, projectId),
        eq(tasks.id, taskId),
      ),
    )
    .returning({
      id: tasks.id,
      projectId: tasks.projectId,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      createdAt: tasks.createdAt,
    });

  return task;
}

export async function deleteWorkspaceTask(
  tx: Transaction,
  projectId: number,
  taskId: number,
) {
  const [task] = await tx
    .delete(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        eq(tasks.id, taskId),
      ),
    )
    .returning({ id: tasks.id });

  return task;
}
