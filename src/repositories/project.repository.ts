import { db } from "../db/index.ts";
import { projects } from "../db/schema.ts";
import { and, desc, eq } from "drizzle-orm";

export async function getAllProject(userId: number) {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      status: projects.status,
      created_at: projects.createdAt,
      user_id: projects.userId,
      task_cache_version: projects.taskCacheVersion,
    })
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.createdAt));

  return rows.map((row) => ({
    ...row,
    task_cache_version: row.task_cache_version.toString(),
  }));
}

export async function getProjectsByUserId(userId: number, projectId: number) {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      status: projects.status,
      created_at: projects.createdAt,
      user_id: projects.userId,
      task_cache_version: projects.taskCacheVersion,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);

  const project = rows[0];

  return project
    ? {
        ...project,
        task_cache_version: project.task_cache_version.toString(),
      }
    : null;
}

export async function createProject(
  name: string,
  description: string,
  status: string,
  userId: number,
) {
  const [project] = await db
    .insert(projects)
    .values({ name, description, status, userId })
    .returning({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      status: projects.status,
      created_at: projects.createdAt,
      user_id: projects.userId,
      task_cache_version: projects.taskCacheVersion,
    });

  return {
    ...project,
    task_cache_version: project.task_cache_version.toString(),
  };
}

export async function updateProject(
  status: string,
  projectId: number,
  userId: number,
) {
  const [project] = await db
    .update(projects)
    .set({ status })
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .returning({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      status: projects.status,
      created_at: projects.createdAt,
      user_id: projects.userId,
      task_cache_version: projects.taskCacheVersion,
    });

  return project
    ? {
        ...project,
        task_cache_version: project.task_cache_version.toString(),
      }
    : null;
}

export async function deleteProject(
  userId: number,
  projectId: number,
) {
  const [project] = await db
    .delete(projects)
    .where(and(
      eq(projects.id, projectId),
      eq(projects.userId, userId),
    ))
    .returning({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      status: projects.status,
      created_at: projects.createdAt,
      user_id: projects.userId,
      task_cache_version: projects.taskCacheVersion,
    });

  return project
    ? {
        ...project,
        task_cache_version: project.task_cache_version.toString(),
      }
    : null;
}
