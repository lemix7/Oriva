import { beforeEach, expect, jest, test } from "@jest/globals";
import type { Request, Response } from "express";
import { userFixture } from "./fixtures.ts";

type Repository = typeof import("../repositories/user.repository.ts");
const findAllUsers = jest.fn<Repository["findAllUsers"]>();
const findUsersById = jest.fn<Repository["findUsersById"]>();
const updateUserRecord = jest.fn<Repository["updateUser"]>();
const deleteUserRecord = jest.fn<Repository["deleteUser"]>();
const repositoryCalls = [findAllUsers, findUsersById, updateUserRecord, deleteUserRecord];

// Importing the users controller also imports registration dependencies.
// Replace these before loading it so no worker, database, or cloud client starts.
jest.unstable_mockModule("../repositories/user.repository.js", () => ({
  findAllUsers,
  findUsersById,
  updateUser: updateUserRecord,
  deleteUser: deleteUserRecord,
  insertUser: jest.fn(),
}));
jest.unstable_mockModule("../queue/email.que.js", () => ({
  default: { add: jest.fn() },
}));
jest.unstable_mockModule("../workers/email.worker.js", () => ({ default: {} }));
jest.unstable_mockModule("../adapters/profile-pic-storage.adapter.js", () => ({
  uploadProfilePicture: jest.fn(),
  deleteProfilePicture: jest.fn(),
}));
jest.unstable_mockModule("dotenv", () => ({ default: { config: jest.fn() } }));

const { getUsers, getUserById, updateUser, deleteUser } =
  await import("../contollers/users.controller.ts");

beforeEach(() => {
  for (const mock of repositoryCalls) mock.mockReset();
  // Successful defaults ensure rejection tests cannot pass because of an
  // unrelated database error or a missing record.
  findAllUsers.mockResolvedValue([userFixture({ id: 99, name: "Another user", email: "another@example.com" })]);
  findUsersById.mockResolvedValue([userFixture()]);
  updateUserRecord.mockResolvedValue(true);
  deleteUserRecord.mockResolvedValue(true);
});

function request(targetId = "42") {
  return {
    user: { userId: 42 },
    params: { user_id: targetId },
    body: { name: "Learner", email: "learner@example.com", userId: 99 },
  } as unknown as Request;
}

function response() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
}

for (const handler of [getUsers, getUserById, updateUser, deleteUser]) {
  test.each([null, "untrusted-user"])(`${handler.name} rejects unauthenticated identity %s before accessing accounts`, async (user) => {
    const req = request();
    if (user === null) delete req.user;
    else req.user = user;
    const res = response();

    await handler(req, res as unknown as Response);

    for (const mock of repositoryCalls) expect(mock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).not.toHaveBeenCalledWith(expect.any(Array));
  });
}

test("blocks the list-all-users endpoint for an authenticated user", async () => {
  const res = response();
  await getUsers(request(), res as unknown as Response);

  expect(findAllUsers).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.json).not.toHaveBeenCalledWith(expect.any(Array));
});

for (const handler of [getUserById, updateUser, deleteUser]) {
  test(`${handler.name} blocks access to another user's account before a repository call`, async () => {
    const req = request("99");
    // A claimed identity in the body must not override authenticated user 42.
    req.body.userId = 99;
    const res = response();

    await handler(req, res as unknown as Response);

    for (const mock of repositoryCalls) expect(mock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.status).not.toHaveBeenCalledWith(200);
  });
}

test("allows a user to read their own account", async () => {
  const res = response();
  await getUserById(request(), res as unknown as Response);

  expect(findUsersById).toHaveBeenCalledTimes(1);
  expect(findUsersById).toHaveBeenCalledWith(42);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith([userFixture()]);
});

test("allows a user to update their own account", async () => {
  const res = response();
  await updateUser(request(), res as unknown as Response);

  expect(updateUserRecord).toHaveBeenCalledTimes(1);
  expect(updateUserRecord).toHaveBeenCalledWith("Learner", "learner@example.com", 42);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.send).toHaveBeenCalledWith("User modified with ID: 42");
});

test("allows a user to delete their own account", async () => {
  const res = response();
  await deleteUser(request(), res as unknown as Response);

  expect(deleteUserRecord).toHaveBeenCalledTimes(1);
  expect(deleteUserRecord).toHaveBeenCalledWith(42);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.send).toHaveBeenCalledWith("User deleted with ID: 42");
});
