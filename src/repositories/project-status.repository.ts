import { db } from "../db/index.ts";
import { projectStatuses, tasks } from "../db/schema.ts";
import { and, asc, eq } from "drizzle-orm";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function insertDefaultProjectStatuses(
  tx: Transaction,
  projectId: number,
) {
  await tx.insert(projectStatuses).values([
    { projectId, name: "Backlog", position: 1000, isDone: false },
    { projectId, name: "In Progress", position: 2000, isDone: false },
    { projectId, name: "Review", position: 3000, isDone: false },
    { projectId, name: "Done", position: 4000, isDone: true },
  ]);
}

export async function getProjectStatuses(projectId: number, tx?: Transaction) {
  const query = tx ?? db;

  return query
    .select()
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId))
    .orderBy(asc(projectStatuses.position), asc(projectStatuses.id));
}

export async function insertProjectStatus(
  tx: Transaction,
  projectId: number,
  input: {
    name: string;
    position: number;
    isDone?: boolean;
  },
) {
  const [status] = await tx
    .insert(projectStatuses)
    .values({
      projectId,
      name: input.name,
      position: input.position,
      isDone: input.isDone ?? false,
    })
    .onConflictDoNothing({
      target: [projectStatuses.projectId, projectStatuses.name],
    })
    .returning();

  return status;
}

export async function updateProjectStatus(
  tx: Transaction,
  projectId: number,
  statusId: number,
  changes: {
    name?: string;
    position?: number;
    isDone?: boolean;
  },
) {
  const [status] = await tx
    .update(projectStatuses)
    .set({
      name: changes.name,
      position: changes.position,
      isDone: changes.isDone,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(projectStatuses.projectId, projectId),
        eq(projectStatuses.id, statusId),
      ),
    )
    .returning();

  return status;
}

export async function deleteProjectStatus(
  tx: Transaction,
  projectId: number,
  statusId: number,
) {
  const [status] = await tx
    .delete(projectStatuses)
    .where(
      and(
        eq(projectStatuses.projectId, projectId),
        eq(projectStatuses.id, statusId),
      ),
    )
    .returning({ id: projectStatuses.id });

  return status;
}

export async function projectStatusHasTasks(
  tx: Transaction,
  projectId: number,
  statusId: number,
) {
  const [task] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.statusId, statusId)))
    .limit(1);

  return task !== undefined;
}
