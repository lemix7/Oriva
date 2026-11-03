import { beforeEach, expect, jest, test } from "@jest/globals";

const getWorkspaceProject = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const getProjectStatuses = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const insertProjectStatus = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const updateProjectStatus = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const deleteProjectStatus = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const projectStatusHasTasks = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const lockWorkspace = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const getWorkspaceMembership = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const findWorkspaceProject = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const tx = {};
const transaction = jest.fn<(callback: (tx: object) => Promise<unknown>) => Promise<unknown>>();
jest.unstable_mockModule("../db/index.js", () => ({ db: { transaction } }));
jest.unstable_mockModule("../repositories/workspace.repository.js", () => ({ lockWorkspace, getWorkspaceMembership }));
jest.unstable_mockModule("../repositories/project.repository.js", () => ({ findWorkspaceProject }));
jest.unstable_mockModule("../services/projects.service.js", () => ({ getWorkspaceProject }));
jest.unstable_mockModule("../repositories/project-status.repository.js", () => ({ getProjectStatuses, insertProjectStatus, updateProjectStatus, deleteProjectStatus, projectStatusHasTasks }));
const { listProjectStatuses, createProjectStatus, editProjectStatus, removeProjectStatus } = await import("../services/project-status.service.ts");

beforeEach(() => {
  for (const mock of [getWorkspaceProject, getProjectStatuses, insertProjectStatus, updateProjectStatus, deleteProjectStatus, projectStatusHasTasks, lockWorkspace, getWorkspaceMembership, findWorkspaceProject]) mock.mockReset();
  transaction.mockReset().mockImplementation(callback => callback(tx));
  lockWorkspace.mockResolvedValue({ id: 1 });
  getWorkspaceMembership.mockResolvedValue({ role: "owner" });
  findWorkspaceProject.mockResolvedValue({ id: 2 });
  getProjectStatuses.mockResolvedValue([{ position: 1000 }, { position: 4000 }]);
  insertProjectStatus.mockResolvedValue({ id: 5, projectId: 2, name: "Testing", position: 5000, isDone: false });
  updateProjectStatus.mockResolvedValue({ id: 5, projectId: 2, name: "Edited", position: 0, isDone: false });
  projectStatusHasTasks.mockResolvedValue(false);
  deleteProjectStatus.mockResolvedValue({ id: 5 });
});

test("status lists check project access before querying statuses", async () => {
  const rows = [{ id: 5, projectId: 2, name: "Backlog", position: 1000, isDone: false }];
  getWorkspaceProject.mockResolvedValue({ id: 2 });
  getProjectStatuses.mockResolvedValue(rows);
  expect(await listProjectStatuses(1, 2, 42)).toEqual(rows);
  expect(getWorkspaceProject).toHaveBeenCalledWith(1, 2, 42);
  expect(getProjectStatuses).toHaveBeenCalledWith(2);
  expect(getWorkspaceProject.mock.invocationCallOrder[0]).toBeLessThan(getProjectStatuses.mock.invocationCallOrder[0]!);
});

test.each(["inaccessible project", "database failure"])("a failed access check prevents status reads: %s", async message => {
  const error = new Error(message);
  getWorkspaceProject.mockRejectedValue(error);
  await expect(listProjectStatuses(1, 2, 42)).rejects.toBe(error);
  expect(getProjectStatuses).not.toHaveBeenCalled();
});

test("status query failures propagate after a successful access check", async () => {
  getWorkspaceProject.mockResolvedValue({ id: 2 });
  const error = new Error("Query failed");
  getProjectStatuses.mockRejectedValue(error);
  await expect(listProjectStatuses(1, 2, 42)).rejects.toBe(error);
});

test.each(["owner", "editor"])("an %s creates a status after locking and reading permissions in the same transaction", async role => {
  getWorkspaceMembership.mockResolvedValue({ role });
  expect(await createProjectStatus(1, 2, 42, { name: "Testing" })).toMatchObject({ name: "Testing", position: 5000 });
  expect(lockWorkspace).toHaveBeenCalledWith(tx, 1);
  expect(getWorkspaceMembership).toHaveBeenCalledWith(1, 42, tx);
  expect(findWorkspaceProject).toHaveBeenCalledWith(1, 2, tx);
  expect(getProjectStatuses).toHaveBeenCalledWith(2, tx);
  expect(insertProjectStatus).toHaveBeenCalledWith(tx, 2, { name: "Testing", isDone: undefined, position: 5000 });
  expect(lockWorkspace.mock.invocationCallOrder[0]).toBeLessThan(getWorkspaceMembership.mock.invocationCallOrder[0]!);
});

test.each(["workspace", "membership"])("a missing %s prevents status creation", async missing => {
  if (missing === "workspace") lockWorkspace.mockResolvedValue(undefined);
  else getWorkspaceMembership.mockResolvedValue(undefined);
  await expect(createProjectStatus(1, 2, 42, { name: "Testing" })).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
  expect(findWorkspaceProject).not.toHaveBeenCalled();
  expect(insertProjectStatus).not.toHaveBeenCalled();
});

test("viewers cannot create statuses", async () => {
  getWorkspaceMembership.mockResolvedValue({ role: "viewer" });
  await expect(createProjectStatus(1, 2, 42, { name: "Testing" })).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
  expect(insertProjectStatus).not.toHaveBeenCalled();
});

test("missing projects are rejected before status insertion", async () => {
  findWorkspaceProject.mockResolvedValue(undefined);
  await expect(createProjectStatus(1, 2, 42, { name: "Testing" })).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
  expect(insertProjectStatus).not.toHaveBeenCalled();
});

test("an empty status list starts at position 1000 and forwards isDone", async () => {
  getProjectStatuses.mockResolvedValue([]);
  await createProjectStatus(1, 2, 42, { name: "Released", isDone: true });
  expect(insertProjectStatus).toHaveBeenCalledWith(tx, 2, { name: "Released", isDone: true, position: 1000 });
});

test("a duplicate name returns a business conflict", async () => {
  insertProjectStatus.mockResolvedValue(undefined);
  await expect(createProjectStatus(1, 2, 42, { name: "Done" })).rejects.toMatchObject({ statusCode: 409, code: "STATUS_ALREADY_EXISTS" });
});

test("failed inserts propagate through the transaction", async () => {
  const error = new Error("Test insert failure");
  insertProjectStatus.mockRejectedValue(error);
  await expect(createProjectStatus(1, 2, 42, { name: "Testing" })).rejects.toBe(error);
});

test.each(["owner", "editor"])("an %s edits a status with permissions checked inside the locked transaction", async role => {
  getWorkspaceMembership.mockResolvedValue({ role });
  const changes = { name: "Edited", position: 0, isDone: false };
  expect(await editProjectStatus(1, 2, 5, 42, changes)).toMatchObject(changes);
  expect(lockWorkspace).toHaveBeenCalledWith(tx, 1);
  expect(getWorkspaceMembership).toHaveBeenCalledWith(1, 42, tx);
  expect(findWorkspaceProject).toHaveBeenCalledWith(1, 2, tx);
  expect(updateProjectStatus).toHaveBeenCalledWith(tx, 2, 5, changes);
  expect(lockWorkspace.mock.invocationCallOrder[0]).toBeLessThan(getWorkspaceMembership.mock.invocationCallOrder[0]!);
});

test.each(["workspace", "membership"])("a missing %s prevents status edits", async missing => {
  if (missing === "workspace") lockWorkspace.mockResolvedValue(undefined);
  else getWorkspaceMembership.mockResolvedValue(undefined);
  await expect(editProjectStatus(1, 2, 5, 42, { name: "Edited" })).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
  expect(updateProjectStatus).not.toHaveBeenCalled();
});

test("viewers cannot edit statuses", async () => {
  getWorkspaceMembership.mockResolvedValue({ role: "viewer" });
  await expect(editProjectStatus(1, 2, 5, 42, { name: "Edited" })).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
  expect(updateProjectStatus).not.toHaveBeenCalled();
});

test("missing projects prevent status edits", async () => {
  findWorkspaceProject.mockResolvedValue(undefined);
  await expect(editProjectStatus(1, 2, 5, 42, { name: "Edited" })).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
  expect(updateProjectStatus).not.toHaveBeenCalled();
});

test.each([{}, { name: undefined, position: undefined, isDone: undefined }])("empty status edits are rejected: %j", async changes => {
  await expect(editProjectStatus(1, 2, 5, 42, changes)).rejects.toMatchObject({ statusCode: 422, code: "EMPTY_UPDATE" });
  expect(updateProjectStatus).not.toHaveBeenCalled();
});

test("a missing status returns not found", async () => {
  updateProjectStatus.mockResolvedValue(undefined);
  await expect(editProjectStatus(1, 2, 5, 42, { name: "Edited" })).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
});

test("failed status edits propagate through the transaction", async () => {
  const error = new Error("Write failed");
  updateProjectStatus.mockRejectedValue(error);
  await expect(editProjectStatus(1, 2, 5, 42, { name: "Edited" })).rejects.toBe(error);
});

test.each([2147482648, 2147483647])("status creation rejects ordering overflow after position %s", async position => {
  getProjectStatuses.mockResolvedValue([{ position }]);
  await expect(createProjectStatus(1, 2, 42, { name: "Testing" })).rejects.toMatchObject({ statusCode: 409, code: "STATUS_ORDER_LIMIT" });
  expect(insertProjectStatus).not.toHaveBeenCalled();
});

test("status creation can append exactly at PostgreSQL's integer limit", async () => {
  getProjectStatuses.mockResolvedValue([{ position: 2147482647 }]);
  await createProjectStatus(1, 2, 42, { name: "Testing" });
  expect(insertProjectStatus).toHaveBeenCalledWith(tx, 2, { name: "Testing", isDone: undefined, position: 2147483647 });
});

test.each(["owner", "editor"])("an %s deletes unused statuses inside the workspace transaction", async role => {
  getWorkspaceMembership.mockResolvedValue({ role });
  expect(await removeProjectStatus(1, 2, 5, 42)).toEqual({ id: 5 });
  expect(lockWorkspace).toHaveBeenCalledWith(tx, 1);
  expect(getWorkspaceMembership).toHaveBeenCalledWith(1, 42, tx);
  expect(findWorkspaceProject).toHaveBeenCalledWith(1, 2, tx);
  expect(projectStatusHasTasks).toHaveBeenCalledWith(tx, 2, 5);
  expect(deleteProjectStatus).toHaveBeenCalledWith(tx, 2, 5);
  expect(lockWorkspace.mock.invocationCallOrder[0]).toBeLessThan(getWorkspaceMembership.mock.invocationCallOrder[0]!);
  expect(projectStatusHasTasks.mock.invocationCallOrder[0]).toBeLessThan(deleteProjectStatus.mock.invocationCallOrder[0]!);
});

test.each(["workspace", "membership"])("a missing %s prevents status deletion", async missing => {
  if (missing === "workspace") lockWorkspace.mockResolvedValue(undefined);
  else getWorkspaceMembership.mockResolvedValue(undefined);
  await expect(removeProjectStatus(1, 2, 5, 42)).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
  expect(projectStatusHasTasks).not.toHaveBeenCalled();
  expect(deleteProjectStatus).not.toHaveBeenCalled();
});

test("viewers cannot delete statuses", async () => {
  getWorkspaceMembership.mockResolvedValue({ role: "viewer" });
  await expect(removeProjectStatus(1, 2, 5, 42)).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
  expect(projectStatusHasTasks).not.toHaveBeenCalled();
  expect(deleteProjectStatus).not.toHaveBeenCalled();
});

test("missing projects prevent status deletion", async () => {
  findWorkspaceProject.mockResolvedValue(undefined);
  await expect(removeProjectStatus(1, 2, 5, 42)).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
  expect(deleteProjectStatus).not.toHaveBeenCalled();
});

test("statuses referenced by tasks return a conflict before deletion", async () => {
  projectStatusHasTasks.mockResolvedValue(true);
  await expect(removeProjectStatus(1, 2, 5, 42)).rejects.toMatchObject({ statusCode: 409, code: "STATUS_IN_USE" });
  expect(deleteProjectStatus).not.toHaveBeenCalled();
});

test("missing statuses return not found", async () => {
  deleteProjectStatus.mockResolvedValue(undefined);
  await expect(removeProjectStatus(1, 2, 5, 42)).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
});

test.each(["references", "deletion"])("status deletion propagates %s query failures", async stage => {
  const error = new Error("Test database failure");
  if (stage === "references") projectStatusHasTasks.mockRejectedValue(error);
  else deleteProjectStatus.mockRejectedValue(error);
  await expect(removeProjectStatus(1, 2, 5, 42)).rejects.toBe(error);
  if (stage === "references") expect(deleteProjectStatus).not.toHaveBeenCalled();
});
