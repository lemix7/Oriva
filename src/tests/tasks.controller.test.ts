import { beforeEach, expect, jest, test } from "@jest/globals";
import type { Request, Response } from "express";
import { joinedTaskFixture, projectFixture, taskFixture } from "./fixtures.ts";

const findOwnedProject =
  jest.fn<typeof import("../repositories/task.repository.ts").findOwnedProject>();
const insertTask =
  jest.fn<typeof import("../repositories/task.repository.ts").insertTask>();

const findTaskForUser = jest.fn<typeof import("../repositories/task.repository.ts").findTaskForUser>();
const updateTaskForUser = jest.fn<typeof import("../repositories/task.repository.ts").updateTaskForUser>();
const deleteTaskForUser = jest.fn<typeof import("../repositories/task.repository.ts").deleteTaskForUser>();
const getCachedTasks = jest.fn<(...args: unknown[]) => Promise<unknown[]>>();

// Replace dependencies before importing the controller so no database or
// Redis connections are created.
jest.unstable_mockModule("../repositories/task.repository.js", () => ({
  findOwnedProject,
  insertTask,
  findTaskForUser,
  updateTaskForUser,
  deleteTaskForUser,
}));
jest.unstable_mockModule("../services/task-cache.service.js", () => ({
  getCachedTasks,
}));

const { create_task, get_tasks, get_task_by_Id, update_task, delete_task } = await import("../contollers/tasks.controller.ts");

beforeEach(() => {
  findOwnedProject.mockReset();
  insertTask.mockReset();
  findTaskForUser.mockReset();
  updateTaskForUser.mockReset();
  deleteTaskForUser.mockReset();
  getCachedTasks.mockReset();
});

test("rejects task creation when the user does not own the project", async () => {
  // Arrange: the ownership lookup finds no project accessible to user 42.
  findOwnedProject.mockResolvedValue(null);
  const req = {
    user: { userId: 42 },
    params: { project_id: "7" },
    body: {
      title: "Private task",
      description: "A task in another user's project",
      status: "on progress",
    },
  } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };

  // Act: call the controller directly with an authenticated request.
  await create_task(req, res as unknown as Response);

  // Assert: check ownership using the authenticated identity, then stop.
  expect(findOwnedProject).toHaveBeenCalledTimes(1);
  expect(findOwnedProject).toHaveBeenCalledWith("7", 42);
  expect(res.status).toHaveBeenCalledTimes(1);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.json).toHaveBeenCalledTimes(1);
  expect(res.json).toHaveBeenCalledWith({ message: "Project not found" });
  expect(insertTask).not.toHaveBeenCalled();
});

test("creates a task in an owned project and returns a 201 success message", async () => {
  // Arrange: ownership is confirmed and the insert succeeds.
  findOwnedProject.mockResolvedValue(projectFixture());
  insertTask.mockResolvedValue([
    taskFixture(),
  ]);
  const req = {
    user: { userId: 42 },
    params: { project_id: "7" },
    body: {
      title: "Write tests",
      description: "Cover successful task creation",
      status: "on progress",
    },
  } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };

  // Act.
  await create_task(req, res as unknown as Response);

  // Assert: use the authenticated owner and pass all task fields to the insert.
  expect(findOwnedProject).toHaveBeenCalledTimes(1);
  expect(findOwnedProject).toHaveBeenCalledWith("7", 42);
  expect(insertTask).toHaveBeenCalledTimes(1);
  expect(insertTask).toHaveBeenCalledWith(
    "Write tests",
    "Cover successful task creation",
    "on progress",
    "7",
  );
  expect(res.status).toHaveBeenCalledTimes(1);
  expect(res.status).toHaveBeenCalledWith(201);
  expect(res.json).toHaveBeenCalledTimes(1);
  expect(res.json).toHaveBeenCalledWith({
    message: "Task is successfully created",
  });
});


function taskRequest(user: Request["user"] = { userId: 42 }) {
  return {
    user, params: { project_id: "7", task_id: "10" },
    body: { title: "Write tests", status: "on progress", userId: 999 },
  } as unknown as Request;
}

function taskResponse() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() };
}

const taskHandlers = [get_tasks, get_task_by_Id, create_task, update_task, delete_task];
for (const handler of taskHandlers) {
  test.each([null, "untrusted-user"])(`${handler.name} rejects unauthenticated identity %s`, async (user) => {
    const req = taskRequest();
    if (user === null) delete req.user;
    else req.user = user;
    const res = taskResponse();
    await handler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith("Unauthorized");
    for (const dependency of [findOwnedProject, insertTask, findTaskForUser, updateTaskForUser, deleteTaskForUser, getCachedTasks]) {
      expect(dependency).not.toHaveBeenCalled();
    }
  });
}

test.each([{ tasks: [] }, { tasks: [{ id: 10 }] }])("lists only results returned for the authenticated user's project: $tasks", async ({ tasks }) => {
  getCachedTasks.mockResolvedValue(tasks);
  const res = taskResponse();
  await get_tasks(taskRequest(), res as unknown as Response);
  expect(getCachedTasks).toHaveBeenCalledWith(42, "7");
  expect(res.status).toHaveBeenCalledWith(200);
  if (tasks.length === 0) expect(res.send).toHaveBeenCalledWith([]);
  else expect(res.json).toHaveBeenCalledWith(tasks);
});

test("single-task lookup passes the authenticated owner, project and task IDs", async () => {
  const tasks = [joinedTaskFixture()];
  findTaskForUser.mockResolvedValue(tasks);
  const res = taskResponse();
  await get_task_by_Id(taskRequest(), res as unknown as Response);
  expect(findTaskForUser).toHaveBeenCalledWith(42, "7", "10");
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith(tasks);
});

test.each([false, true])("updating an owned task handles affected-row result %s", async (updated) => {
  updateTaskForUser.mockResolvedValue(updated);
  const res = taskResponse();
  await update_task(taskRequest(), res as unknown as Response);
  expect(updateTaskForUser).toHaveBeenCalledWith("done", "10", 42, "7");
  expect(res.status).toHaveBeenCalledWith(updated ? 200 : 404);
  expect(res.json).toHaveBeenCalledWith(updated ? "task is updated to done" : { message: "Task not found" });
});

test("deleting a task passes the authenticated owner to the repository", async () => {
  deleteTaskForUser.mockResolvedValue(true);
  const res = taskResponse();
  await delete_task(taskRequest(), res as unknown as Response);
  expect(deleteTaskForUser).toHaveBeenCalledWith(42, "7", "10");
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith("task is deleted");
});

test("does not report successful deletion when no owned task was deleted", async () => {
  // A missing task and a task belonging to another user both affect zero rows.
  deleteTaskForUser.mockResolvedValue(false);
  const res = taskResponse();

  await delete_task(taskRequest(), res as unknown as Response);

  expect(deleteTaskForUser).toHaveBeenCalledWith(42, "7", "10");
  expect(res.status).toHaveBeenCalledWith(404);
  expect(res.json).toHaveBeenCalledWith({ message: "Task not found" });
  expect(res.status).not.toHaveBeenCalledWith(200);
  expect(res.json).not.toHaveBeenCalledWith("task is deleted");
});

test("ownership lookup failure prevents task insertion and a success response", async () => {
  const error = new Error("ownership lookup failed");
  findOwnedProject.mockRejectedValue(error);
  const res = taskResponse();
  await expect(create_task(taskRequest(), res as unknown as Response)).rejects.toBe(error);
  expect(insertTask).not.toHaveBeenCalled();
  expect(res.json).not.toHaveBeenCalled();
});

test("task insertion failure does not send the creation success message", async () => {
  findOwnedProject.mockResolvedValue(projectFixture());
  const error = new Error("insert failed");
  insertTask.mockRejectedValue(error);
  const res = taskResponse();
  await expect(create_task(taskRequest(), res as unknown as Response)).rejects.toBe(error);
  expect(res.status).not.toHaveBeenCalled();
  expect(res.json).not.toHaveBeenCalled();
});
