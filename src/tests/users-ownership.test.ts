import { beforeEach, expect, jest, test } from "@jest/globals";
import type { Request, Response } from "express";

type Repository = typeof import("../repositories/user.repository.ts");
const findUserProfileById = jest.fn<
  (userId: number) => Promise<Awaited<ReturnType<Repository["findUserProfileById"]>> | undefined>
>();
const editCurrentUserProfile = jest.fn<(...args: unknown[]) => Promise<unknown>>();
// Importing the users controller also imports registration dependencies.
// Replace these before loading it so no worker, database, or cloud client starts.
jest.unstable_mockModule("../repositories/user.repository.js", () => ({
  findUserProfileById,
  insertUser: jest.fn(),
}));
jest.unstable_mockModule("../queue/email.que.js", () => ({
  default: { add: jest.fn() },
}));
jest.unstable_mockModule("../services/user.service.js", () => ({ editCurrentUserProfile }));
jest.unstable_mockModule("../workers/email.worker.js", () => ({ default: {} }));
jest.unstable_mockModule("../adapters/profile-pic-storage.adapter.js", () => ({
  uploadProfilePicture: jest.fn(),
  deleteProfilePicture: jest.fn(),
}));
jest.unstable_mockModule("dotenv", () => ({ default: { config: jest.fn() } }));

const { getMeController, updateMeController } = await import(
  "../controllers/users.controller.ts"
);

beforeEach(() => {
  editCurrentUserProfile.mockReset();
  findUserProfileById.mockReset();
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

test("GET /me uses only the authenticated ID and returns the safe profile", async () => {
  const profile = { id: 42, name: "Learner", email: "learner@example.com" };
  findUserProfileById.mockResolvedValue(profile);
  const req = request("99");
  req.query = { userId: "99" };
  const res = response();
  await getMeController(req, res as unknown as Response);
  expect(findUserProfileById).toHaveBeenCalledTimes(1);
  expect(findUserProfileById).toHaveBeenCalledWith(42);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ data: profile });
});

test.each([undefined, "token", {}, { userId: "42" }, { userId: 0 }, { userId: -1 }, { userId: 1.5 }, { userId: 2147483648 }])(
  "GET /me rejects invalid identity %j before looking up a user", async (user) => {
    const res = response();
    await expect(getMeController({ user } as unknown as Request, res as unknown as Response))
      .rejects.toMatchObject({ statusCode: 401, code: "UNAUTHENTICATED" });
    expect(findUserProfileById).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  },
);

test("GET /me returns not found for a deleted account", async () => {
  findUserProfileById.mockResolvedValue(undefined);
  const res = response();
  await expect(getMeController(request(), res as unknown as Response))
    .rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
  expect(res.status).not.toHaveBeenCalled();
});

test("GET /me propagates database failures without sending success", async () => {
  const error = new Error("Test database failure");
  findUserProfileById.mockRejectedValue(error);
  const res = response();
  await expect(getMeController(request(), res as unknown as Response)).rejects.toBe(error);
  expect(res.status).not.toHaveBeenCalled();
});

test("PATCH /me forwards only validated fields and the authenticated identity", async () => {
  const profile = { id: 42, name: "Updated name", email: "updated@example.com" };
  editCurrentUserProfile.mockResolvedValue(profile);
  const req = request("99");
  const res = { ...response(), locals: { validatedData: { ...profile, userId: 99, role: "owner", password: "ignored" } } };
  await updateMeController(req, res as unknown as Response);
  expect(editCurrentUserProfile).toHaveBeenCalledWith(42, { name: profile.name, email: profile.email });
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ data: profile });
});

test.each([undefined, "token", {}, { userId: "42" }, { userId: 0 }, { userId: -1 }, { userId: 1.5 }, { userId: 2147483648 }])(
  "PATCH /me rejects invalid identity %j before updating", async (user) => {
    const res = response();
    await expect(updateMeController({ user } as unknown as Request, res as unknown as Response))
      .rejects.toMatchObject({ statusCode: 401, code: "UNAUTHENTICATED" });
    expect(editCurrentUserProfile).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  },
);

test("PATCH /me forwards partial updates without inventing omitted values", async () => {
  editCurrentUserProfile.mockResolvedValue({ id: 42, name: "Updated name", email: "learner@example.com" });
  const res = { ...response(), locals: { validatedData: { name: "Updated name" } } };
  await updateMeController(request(), res as unknown as Response);
  expect(editCurrentUserProfile).toHaveBeenCalledWith(42, { name: "Updated name", email: undefined });
});

test("PATCH /me propagates service failures without responding with success", async () => {
  const error = new Error("Test update failure");
  editCurrentUserProfile.mockRejectedValue(error);
  const res = { ...response(), locals: { validatedData: { name: "Updated name" } } };
  await expect(updateMeController(request(), res as unknown as Response)).rejects.toBe(error);
  expect(res.status).not.toHaveBeenCalled();
});
