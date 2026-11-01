import { beforeEach, expect, jest, test } from "@jest/globals";
import type { Request, Response } from "express";
import { AppError } from "../shared/app-error.ts";

const createWorkspaceTask = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const getWorkspaceTask = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const editWorkspaceTask = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const removeWorkspaceTask = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const listWorkspaceTasks = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule("../services/tasks.service.js", () => ({ createWorkspaceTask, getWorkspaceTask, editWorkspaceTask, removeWorkspaceTask, listWorkspaceTasks }));
const controllers = await import("../controllers/tasks.controller.ts");
const input = { title: "Validated value", description: null, status: "done" };
const record = { id: 33, title: "Saved value" };
const cases = [
  { name: "create", handler: controllers.createWorkspaceTaskController, service: createWorkspaceTask, args: [11, 22, 42, input], result: record, code: 201 },
  { name: "get", handler: controllers.getWorkspaceTaskController, service: getWorkspaceTask, args: [11, 22, 33, 42], result: record, code: 200 },
  { name: "edit", handler: controllers.editWorkspaceTaskController, service: editWorkspaceTask, args: [11, 22, 33, 42, input], result: record, code: 200 },
  { name: "remove", handler: controllers.removeWorkspaceTaskController, service: removeWorkspaceTask, args: [11, 22, 33, 42], result: { id: 33 }, code: 204 },
  { name: "list", handler: controllers.listWorkspaceTasksController, service: listWorkspaceTasks, args: [11, 22, 42, 9], result: { data: [record], nextCursor: 33 }, code: 200 },
];

function response(data: Record<string, unknown> = { ...input, afterId: 9, userId: 999, workspaceId: 999, projectId: 999 }) {
  const res = {
    locals: { validatedParams: { wid: 11, pid: 22, tid: 33 }, validatedData: data },
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
  return res as unknown as Response & typeof res;
}

beforeEach(() => { for (const entry of cases) entry.service.mockReset(); });

for (const entry of cases) {
  test(`${entry.name} uses validated input and the authenticated identity`, async () => {
    entry.service.mockResolvedValue(entry.result);
    const req = { user: { userId: 42 }, params: { wid: "999" }, body: { userId: 999 } } as unknown as Request;
    const res = response();
    await entry.handler(req, res);
    expect(entry.service).toHaveBeenCalledTimes(1);
    expect(entry.service).toHaveBeenCalledWith(...entry.args);
    expect(res.status).toHaveBeenCalledWith(entry.code);
    if (entry.name === "remove") {
      expect(res.send).toHaveBeenCalledWith();
      expect(res.json).not.toHaveBeenCalled();
    } else {
      expect(res.json).toHaveBeenCalledWith(entry.name === "list"
        ? { data: [record], page: { nextCursor: 33 } } : { data: record });
    }
  });

  test.each([undefined, "token", { userId: "42" }, { userId: 0 }, { userId: 1.5 }, { userId: 2147483648 }])(
    `${entry.name} rejects an invalid authenticated identity: %j`, async (user) => {
      const res = response();
      await expect(entry.handler({ user } as unknown as Request, res)).rejects.toMatchObject({ statusCode: 401, code: "UNAUTHENTICATED" });
      expect(entry.service).not.toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    },
  );

  test(`${entry.name} propagates service errors without sending success`, async () => {
    const error = new AppError(403, "FORBIDDEN", "Permission denied");
    entry.service.mockRejectedValue(error);
    const res = response();
    await expect(entry.handler({ user: { userId: 42 } } as unknown as Request, res)).rejects.toBe(error);
    expect(res.status).not.toHaveBeenCalled();
  });
}

test("list defaults the cursor to zero and returns the final page", async () => {
  listWorkspaceTasks.mockResolvedValue({ data: [], nextCursor: null });
  const res = response({});
  await controllers.listWorkspaceTasksController({ user: { userId: 42 } } as unknown as Request, res);
  expect(listWorkspaceTasks).toHaveBeenCalledWith(11, 22, 42, 0);
  expect(res.json).toHaveBeenCalledWith({ data: [], page: { nextCursor: null } });
});
