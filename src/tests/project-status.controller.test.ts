import { beforeEach, expect, jest, test } from "@jest/globals";
import type { Request, Response } from "express";

const listProjectStatuses = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const createProjectStatus = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const editProjectStatus = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const removeProjectStatus = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule("../services/project-status.service.js", () => ({ listProjectStatuses, createProjectStatus, editProjectStatus, removeProjectStatus }));
const { listProjectStatusesController, createProjectStatusController, editProjectStatusController, removeProjectStatusController } = await import("../controllers/project-status-controller.ts");
beforeEach(() => { listProjectStatuses.mockReset(); createProjectStatus.mockReset(); editProjectStatus.mockReset(); removeProjectStatus.mockReset(); });

function response() {
  return {
    locals: { validatedParams: { wid: 1, pid: 2 } },
    status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
}

test("status controller uses validated route IDs and the authenticated user", async () => {
  const statuses = [{ id: 3, projectId: 2, name: "Done", position: 4000, isDone: true }];
  listProjectStatuses.mockResolvedValue(statuses);
  const res = response();
  await listProjectStatusesController({ user: { userId: 42 }, params: { wid: "99", pid: "99" }, body: { userId: 99 } } as unknown as Request, res as unknown as Response);
  expect(listProjectStatuses).toHaveBeenCalledWith(1, 2, 42);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ data: statuses });
});

test.each([undefined, "token", {}, { userId: "42" }, { userId: 0 }, { userId: -1 }, { userId: 1.5 }, { userId: 2147483648 }])(
  "status controller rejects invalid identity %j before service access", async user => {
    const res = response();
    await expect(listProjectStatusesController({ user } as unknown as Request, res as unknown as Response))
      .rejects.toMatchObject({ statusCode: 401, code: "UNAUTHENTICATED" });
    expect(listProjectStatuses).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  },
);

test("status controller propagates errors without sending success", async () => {
  const error = new Error("Status read failed");
  listProjectStatuses.mockRejectedValue(error);
  const res = response();
  await expect(listProjectStatusesController({ user: { userId: 42 } } as unknown as Request, res as unknown as Response)).rejects.toBe(error);
  expect(res.status).not.toHaveBeenCalled();
});

test("status creation forwards only allowed validated fields and the authenticated user", async () => {
  const status = { id: 3, projectId: 2, name: "Testing", position: 5000, isDone: false };
  createProjectStatus.mockResolvedValue(status);
  const res = { ...response(), locals: { validatedParams: { wid: 1, pid: 2 }, validatedData: { name: "Testing", isDone: false, projectId: 99, userId: 99, position: -1 } } };
  await createProjectStatusController({ user: { userId: 42 }, body: { userId: 99 } } as unknown as Request, res as unknown as Response);
  expect(createProjectStatus).toHaveBeenCalledWith(1, 2, 42, { name: "Testing", isDone: false });
  expect(res.status).toHaveBeenCalledWith(201);
  expect(res.json).toHaveBeenCalledWith({ data: status });
});

test.each([undefined, "token", {}, { userId: "42" }, { userId: 0 }, { userId: -1 }, { userId: 1.5 }, { userId: 2147483648 }])(
  "status creation rejects invalid identity %j", async user => {
    const res = response();
    await expect(createProjectStatusController({ user } as unknown as Request, res as unknown as Response)).rejects.toMatchObject({ statusCode: 401, code: "UNAUTHENTICATED" });
    expect(createProjectStatus).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  },
);

test("status creation propagates service failures without sending success", async () => {
  const error = new Error("Creation failed");
  createProjectStatus.mockRejectedValue(error);
  const res = { ...response(), locals: { validatedParams: { wid: 1, pid: 2 }, validatedData: { name: "Testing" } } };
  await expect(createProjectStatusController({ user: { userId: 42 } } as unknown as Request, res as unknown as Response)).rejects.toBe(error);
  expect(res.status).not.toHaveBeenCalled();
});

test("status edits forward only validated mutable fields and authenticated identity", async () => {
  const status = { id: 3, projectId: 2, name: "Edited", position: 0, isDone: false };
  editProjectStatus.mockResolvedValue(status);
  const res = { ...response(), locals: { validatedParams: { wid: 1, pid: 2, sid: 3 }, validatedData: { name: "Edited", position: 0, isDone: false, id: 99, projectId: 99, userId: 99 } } };
  await editProjectStatusController({ user: { userId: 42 }, body: { userId: 99 } } as unknown as Request, res as unknown as Response);
  expect(editProjectStatus).toHaveBeenCalledWith(1, 2, 3, 42, { name: "Edited", position: 0, isDone: false });
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ data: status });
});

test.each([undefined, "token", {}, { userId: "42" }, { userId: 0 }, { userId: -1 }, { userId: 1.5 }, { userId: 2147483648 }])(
  "status editing rejects invalid identity %j before service access", async user => {
    const res = response();
    await expect(editProjectStatusController({ user } as unknown as Request, res as unknown as Response)).rejects.toMatchObject({ statusCode: 401, code: "UNAUTHENTICATED" });
    expect(editProjectStatus).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  },
);

test("status edit errors propagate without a success response", async () => {
  const error = new Error("Update failed");
  editProjectStatus.mockRejectedValue(error);
  const res = { ...response(), locals: { validatedParams: { wid: 1, pid: 2, sid: 3 }, validatedData: { name: "Edited" } } };
  await expect(editProjectStatusController({ user: { userId: 42 } } as unknown as Request, res as unknown as Response)).rejects.toBe(error);
  expect(res.status).not.toHaveBeenCalled();
});

test("status deletion uses validated IDs and returns an empty 204", async () => {
  removeProjectStatus.mockResolvedValue({ id: 3 });
  const res = { ...response(), locals: { validatedParams: { wid: 1, pid: 2, sid: 3 } } };
  await removeProjectStatusController({ user: { userId: 42 }, params: { wid: "99", pid: "99", sid: "99" }, body: { userId: 99 } } as unknown as Request, res as unknown as Response);
  expect(removeProjectStatus).toHaveBeenCalledWith(1, 2, 3, 42);
  expect(res.status).toHaveBeenCalledWith(204);
  expect(res.send).toHaveBeenCalledWith();
  expect(res.json).not.toHaveBeenCalled();
});

test.each([undefined, "token", {}, { userId: "42" }, { userId: 0 }, { userId: -1 }, { userId: 1.5 }, { userId: 2147483648 }])(
  "status deletion rejects invalid identity %j", async user => {
    const res = response();
    await expect(removeProjectStatusController({ user } as unknown as Request, res as unknown as Response)).rejects.toMatchObject({ statusCode: 401, code: "UNAUTHENTICATED" });
    expect(removeProjectStatus).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  },
);

test("failed status deletion does not send a success response", async () => {
  const error = new Error("Deletion failed");
  removeProjectStatus.mockRejectedValue(error);
  const res = { ...response(), locals: { validatedParams: { wid: 1, pid: 2, sid: 3 } } };
  await expect(removeProjectStatusController({ user: { userId: 42 } } as unknown as Request, res as unknown as Response)).rejects.toBe(error);
  expect(res.status).not.toHaveBeenCalled();
});
