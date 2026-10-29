import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { projects, tasks } from "../db/schema.ts";

const projectFields = {
  id: projects.id,
  name: projects.name,
  description: projects.description,
  status: projects.status,
  created_at: projects.createdAt,
  user_id: projects.userId,
  task_cache_version: projects.taskCacheVersion,
};

const taskFields = {
  id: tasks.id,
  title: tasks.title,
  project_id: tasks.projectId,
  description: tasks.description,
  status: tasks.status,
  created_at: tasks.createdAt,
};

// Preserve the old SELECT * join's flat response: project columns win when
// both tables have an id, description, status, or created_at column.
const joinedFields = { ...taskFields, ...projectFields };

function routeId(value: string | string[]): number {
  if (typeof value !== "string" || !/^\s*[+-]?\d+\s*$/.test(value)) {
    throw new Error("Invalid database ID");
  }
  const id = Number(value);
  if (!Number.isInteger(id) || id < -2147483648 || id > 2147483647) {
    throw new Error("Invalid database ID");
  }
  return id;
}

export async function findTaskCacheVersion(userId: number, projectId: string | string[]): Promise<string | null> {
  const [project] = await db
    .select({ version: projects.taskCacheVersion })
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.id, routeId(projectId))))
    .limit(1);
  return project?.version.toString() ?? null;
}

export async function findTasksForUser(userId: number, projectId: string | string[]) {
  const rows = await db
    .select(joinedFields)
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(eq(projects.userId, userId), eq(projects.id, routeId(projectId))));
  return rows.map((row) => ({ ...row, task_cache_version: row.task_cache_version.toString() }));
}

export async function findTaskForUser(
  userId: number,
  projectId: string | string[],
  taskId: string | string[],
) {
  const rows = await db
    .select(joinedFields)
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(
      eq(projects.userId, userId),
      eq(projects.id, routeId(projectId)),
      eq(tasks.id, routeId(taskId)),
    ));
  return rows.map((row) => ({ ...row, task_cache_version: row.task_cache_version.toString() }));
}

export async function findOwnedProject(projectId: string | string[], userId: number) {
  const [project] = await db
    .select(projectFields)
    .from(projects)
    .where(and(eq(projects.id, routeId(projectId)), eq(projects.userId, userId)))
    .limit(1);
  return project
    ? { ...project, task_cache_version: project.task_cache_version.toString() }
    : null;
}

export async function insertTask(
  title: string,
  description: string | undefined,
  status: string,
  projectId: string | string[],
) {
  return db
    .insert(tasks)
    .values({ title, description: description ?? null, status: status ?? null, projectId: routeId(projectId) })
    .returning(taskFields);
}

export async function updateTaskForUser(
  update: string,
  taskId: string | string[],
  userId: number,
  projectId: string | string[],
) {
  const ownedProject = db.select({ id: projects.id }).from(projects)
    .where(and(eq(projects.id, routeId(projectId)), eq(projects.userId, userId)));
  const rows = await db.update(tasks).set({ status: update })
    .where(and(eq(tasks.id, routeId(taskId)), inArray(tasks.projectId, ownedProject)))
    .returning({ id: tasks.id });
  return rows.length > 0;
}

export async function deleteTaskForUser(
  userId: number,
  projectId: string | string[],
  taskId: string | string[],
) {
  const ownedProject = db.select({ id: projects.id }).from(projects)
    .where(and(eq(projects.id, routeId(projectId)), eq(projects.userId, userId)));
  const rows = await db.delete(tasks)
    .where(and(eq(tasks.id, routeId(taskId)), inArray(tasks.projectId, ownedProject)))
    .returning({ id: tasks.id });
  return rows.length > 0;
}
