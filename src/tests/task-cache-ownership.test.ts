import { beforeEach, expect, jest, test } from "@jest/globals";
import { joinedTaskFixture } from "./fixtures.ts";

type Repository = typeof import("../repositories/task.repository.ts");
const findTaskCacheVersion = jest.fn<Repository["findTaskCacheVersion"]>();
const findTasksForUser = jest.fn<Repository["findTasksForUser"]>();
const get = jest.fn<(key: string) => Promise<string | null>>();
const set = jest.fn<(...args: unknown[]) => Promise<string>>();

jest.unstable_mockModule("../repositories/task.repository.js", () => ({
  findTaskCacheVersion, findTasksForUser,
}));
jest.unstable_mockModule("../config/task-cache.js", () => ({ default: { get, set } }));
const { getCachedTasks } = await import("../services/task-cache.service.ts");

beforeEach(() => {
  findTaskCacheVersion.mockReset();
  findTasksForUser.mockReset();
  get.mockReset();
  set.mockReset();
});

test("an inaccessible or missing project never reads or populates the cache", async () => {
  findTaskCacheVersion.mockResolvedValue(null);
  await expect(getCachedTasks(42, "7")).resolves.toEqual([]);
  expect(findTaskCacheVersion).toHaveBeenCalledWith(42, "7");
  expect(get).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
  expect(findTasksForUser).not.toHaveBeenCalled();
});

test("an ownership lookup failure does not fall back to cached data", async () => {
  const error = new Error("ownership lookup unavailable");
  findTaskCacheVersion.mockRejectedValue(error);
  await expect(getCachedTasks(42, "7")).rejects.toBe(error);
  expect(get).not.toHaveBeenCalled();
  expect(findTasksForUser).not.toHaveBeenCalled();
});

test("cached reads use a separate key for each authenticated owner", async () => {
  findTaskCacheVersion.mockResolvedValue("3");
  get.mockResolvedValueOnce(JSON.stringify([{ id: 10 }])).mockResolvedValueOnce("[]");
  await expect(getCachedTasks(42, "7")).resolves.toEqual([{ id: 10 }]);
  await expect(getCachedTasks(99, "7")).resolves.toEqual([]);
  expect(findTaskCacheVersion).toHaveBeenNthCalledWith(1, 42, "7");
  expect(findTaskCacheVersion).toHaveBeenNthCalledWith(2, 99, "7");
  expect(get).toHaveBeenNthCalledWith(1, "user:42:project:7:tasks:v3");
  expect(get).toHaveBeenNthCalledWith(2, "user:99:project:7:tasks:v3");
  expect(findTasksForUser).not.toHaveBeenCalled();
});

test("a cache miss queries tasks for the authenticated owner and project", async () => {
  const tasks = [joinedTaskFixture()];
  findTaskCacheVersion.mockResolvedValue("3");
  get.mockResolvedValue(null);
  findTasksForUser.mockResolvedValue(tasks);
  set.mockResolvedValue("OK");
  await expect(getCachedTasks(42, "7")).resolves.toEqual(tasks);
  expect(findTasksForUser).toHaveBeenCalledWith(42, "7");
  expect(set).toHaveBeenCalledWith("user:42:project:7:tasks:v3", JSON.stringify(tasks), "EX", 1800);
});
