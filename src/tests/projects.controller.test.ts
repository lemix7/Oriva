import { beforeEach, expect, jest, test } from "@jest/globals";
import type { Request, Response } from "express";

type Repository = typeof import("../repositories/project.repository.ts");
const getAllProject = jest.fn<Repository["getAllProject"]>();
const getProjectsByUserId = jest.fn<Repository["getProjectsByUserId"]>();
const createProject = jest.fn<Repository["createProject"]>();
const updateProject = jest.fn<Repository["updateProject"]>();
const deleteProject = jest.fn<Repository["deleteProject"]>();
const dependencies = [getAllProject, getProjectsByUserId, createProject, updateProject, deleteProject];

jest.unstable_mockModule("../repositories/project.repository.js", () => ({
  getAllProject, getProjectsByUserId, createProject, updateProject, deleteProject,
}));
const { get_projects, get_project_by_ID, create_project, update_project, delete_project } =
  await import("../contollers/projects.controller.ts");

beforeEach(() => {
  for (const mock of dependencies) mock.mockReset();
});

function request(projectId = "7") {
  return {
    user: { userId: 42 }, params: { project_id: projectId },
    body: { userId: 999 }, // Caller-provided identity must not override authentication.
  } as unknown as Request;
}

function response() {
  return {
    status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    locals: { validatedData: { name: "Test project", description: "Learning tests", status: "active" } },
  };
}

for (const handler of [get_projects, get_project_by_ID, create_project, update_project, delete_project]) {
  test.each([null, "untrusted-user"])(`${handler.name} rejects unauthenticated identity %s`, async (user) => {
    const req = request();
    if (user === null) delete req.user;
    else req.user = user;
    const res = response();
    await handler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith("Unauthorized");
    for (const mock of dependencies) expect(mock).not.toHaveBeenCalled();
  });
}

for (const handler of [get_project_by_ID, update_project, delete_project]) {
  test.each(["0", "-1", "1.5", "abc"])(`${handler.name} rejects invalid project ID %s before querying`, async (id) => {
    const res = response();
    await handler(request(id), res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: "Invalid project ID" });
    for (const mock of dependencies) expect(mock).not.toHaveBeenCalled();
  });
}

test("lists projects using the authenticated owner", async () => {
  const projects = [{ id: 7, user_id: 42 }];
  getAllProject.mockResolvedValue(projects);
  const res = response();
  await get_projects(request(), res as unknown as Response);
  expect(getAllProject).toHaveBeenCalledWith(42);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith(projects);
});

test.each([null, { id: 7, user_id: 42 }])("reads a project through the ownership-filtered lookup: %j", async (project) => {
  getProjectsByUserId.mockResolvedValue(project);
  const res = response();
  await get_project_by_ID(request(), res as unknown as Response);
  expect(getProjectsByUserId).toHaveBeenCalledWith(42, 7);
  expect(res.status).toHaveBeenCalledWith(project ? 200 : 404);
  expect(res.json).toHaveBeenCalledWith(project ?? { message: "Project not found" });
});

test("creates a project for the authenticated owner using validated data", async () => {
  const project = { id: 7, user_id: 42 };
  createProject.mockResolvedValue(project);
  const res = response();
  await create_project(request(), res as unknown as Response);
  expect(createProject).toHaveBeenCalledWith("Test project", "Learning tests", "active", 42);
  expect(res.status).toHaveBeenCalledWith(201);
  expect(res.json).toHaveBeenCalledWith(project);
});

test.each([null, { id: 7, user_id: 42 }])("updates a project through the ownership-filtered repository: %j", async (project) => {
  updateProject.mockResolvedValue(project);
  const res = response();
  await update_project(request(), res as unknown as Response);
  expect(updateProject).toHaveBeenCalledWith("completed", 7, 42);
  expect(res.status).toHaveBeenCalledWith(project ? 200 : 404);
  expect(res.json).toHaveBeenCalledWith(project ? "project status updated" : { message: "Project not found" });
});

test.each([null, { id: 7, user_id: 42 }])("deletes a project through the ownership-filtered repository: %j", async (project) => {
  deleteProject.mockResolvedValue(project);
  const res = response();
  await delete_project(request(), res as unknown as Response);
  expect(deleteProject).toHaveBeenCalledWith(42, 7);
  expect(res.status).toHaveBeenCalledWith(project ? 200 : 404);
  expect(res.json).toHaveBeenCalledWith(project ? "project is deleted" : { message: "Project not found" });
});

test("a failed ownership-filtered update does not send success", async () => {
  const error = new Error("database unavailable");
  updateProject.mockRejectedValue(error);
  const res = response();
  await expect(update_project(request(), res as unknown as Response)).rejects.toBe(error);
  expect(res.json).not.toHaveBeenCalled();
});
