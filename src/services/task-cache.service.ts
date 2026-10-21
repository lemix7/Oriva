import taskCache from "../config/task-cache.ts";
import {
  findTaskCacheVersion,
  findTasksForUser,
} from "../repositories/task.repository.ts";

const TASK_CACHE_TTL = 30 * 60; // time to live for the cache

export async function getCachedTasks(
  userId: number,
  projectId: string | string[],
) {
  const version = await findTaskCacheVersion(userId, projectId);

  if (version == null) {
    return [];
  }

  const key = `user:${userId}:project:${projectId}:tasks:v${version}`; // the key that each task will be stored with

  // check the task in CACHE
  try {
    const cached = await taskCache.get(key);

    if (cached !== null) {
      console.log("CACHE HIT: returning tasks from Redis");
      return JSON.parse(cached);
      //   if (
      //     Array.isArray(tasks) &&
      //     tasks.every(
      //       (task) =>
      //         task !== null && typeof task === "object" && !Array.isArray(task),
      //     )
      //   ) {
      //     return tasks;
      //   }
    }
  } catch (error) {
    console.error("Could not read task cache:", error);
  }

  console.log("CACHE MISS: fetching tasks from PostgreSQL");
  const tasks = await findTasksForUser(userId, projectId);

  // insert the task into the CACHE
  try {
    await taskCache.set(key, JSON.stringify(tasks), "EX", TASK_CACHE_TTL);
  } catch (error) {
    console.error("Could not populate task cache:", error);
  }

  return tasks;
}
