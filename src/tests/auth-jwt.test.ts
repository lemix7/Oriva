import { afterAll, beforeAll, beforeEach, expect, jest, test } from "@jest/globals";
import type { Request, Response } from "express";
import type { VerifyCallback } from "jsonwebtoken";

const verify = jest.fn<
  (token: string, secret: string, callback: VerifyCallback) => void
>();

const query = jest.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>();
const compare = jest.fn<(password: string, hash: string) => Promise<boolean>>();
const sign = jest.fn<(...args: unknown[]) => string>();

// Register mocks before importing the ES module under test.
jest.unstable_mockModule("jsonwebtoken", () => ({
  default: { verify, sign },
}));
jest.unstable_mockModule("../pool/pooler.js", () => ({
  default: { query },
}));
jest.unstable_mockModule("dotenv", () => ({
  default: { config: jest.fn() },
}));

jest.unstable_mockModule("bcryptjs", () => ({ default: { compare } }));

const originalSecret = process.env.SECRET_KEY;
let login: typeof import("../auth/auth-jwt.ts").login;
let authenticateJWT: typeof import("../auth/auth-jwt.ts").authenticateJWT;

beforeAll(async () => {
  // The middleware reads this setting when its module is imported.
  process.env.SECRET_KEY = "unit-test-secret";
  ({ authenticateJWT, login } = await import("../auth/auth-jwt.ts"));
});

beforeEach(() => {
  verify.mockReset();
  query.mockReset();
  compare.mockReset();
  sign.mockReset();
});

afterAll(() => {
  if (originalSecret === undefined) {
    delete process.env.SECRET_KEY;
  } else {
    process.env.SECRET_KEY = originalSecret;
  }
});

test("rejects a request without an Authorization header and stops the chain", async () => {
  // Arrange: provide only the request and response members this path uses.
  const req = { headers: {} } as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
  const next = jest.fn();

  // Act: call the middleware directly, without starting an HTTP server.
  await authenticateJWT(req, res as unknown as Response, next);

  // Assert: reject the request without continuing to protected code.
  expect(res.status).toHaveBeenCalledTimes(1);
  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.send).toHaveBeenCalledTimes(1);
  expect(res.send).toHaveBeenCalledWith("Token required");
  expect(next).not.toHaveBeenCalled();
});

test("rejects an invalid token without attaching a user or continuing", async () => {
  // Arrange: simulate the error reported by JWT verification.
  verify.mockReset();
  verify.mockImplementation((_token, _secret, callback) => {
    callback(Object.assign(new Error("invalid token"), {
      name: "JsonWebTokenError",
      inner: new Error("invalid signature"),
    }));
  });
  const req = {
    headers: { authorization: "Bearer invalid-token" },
  } as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
  const next = jest.fn();

  // Act.
  await authenticateJWT(req, res as unknown as Response, next);

  // Assert: verify the extracted token, then the rejection behavior.
  expect(verify).toHaveBeenCalledTimes(1);
  expect(verify).toHaveBeenCalledWith(
    "invalid-token",
    "unit-test-secret",
    expect.any(Function),
  );
  expect(res.status).toHaveBeenCalledTimes(1);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.send).toHaveBeenCalledTimes(1);
  expect(res.send).toHaveBeenCalledWith("Invalid token");
  expect(next).not.toHaveBeenCalled();
  expect(req.user).toBeUndefined();
});

test("attaches the verified user and continues without sending a response", async () => {
  // Arrange: simulate successful verification with a decoded user payload.
  const user = { userId: 42 };
  verify.mockReset();
  verify.mockImplementation((_token, _secret, callback) => {
    callback(null, user);
  });
  const req = {
    headers: { authorization: "Bearer valid-token" },
  } as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis(),
  };
  const next = jest.fn();

  // Act.
  await authenticateJWT(req, res as unknown as Response, next);

  // Assert: pass identity through the request, not as an argument to next.
  expect(verify).toHaveBeenCalledTimes(1);
  expect(verify).toHaveBeenCalledWith(
    "valid-token",
    "unit-test-secret",
    expect.any(Function),
  );
  expect(req.user).toEqual(user);
  expect(next).toHaveBeenCalledTimes(1);
  expect(next).toHaveBeenCalledWith();
  expect(res.status).not.toHaveBeenCalled();
  expect(res.send).not.toHaveBeenCalled();
  expect(res.json).not.toHaveBeenCalled();
  expect(res.end).not.toHaveBeenCalled();
});

function loginRequest() {
  return { body: { email: "learner@example.com", password: "password123" } } as Request;
}

function loginResponse() {
  return { status: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() };
}

test.each(["Basic abc", "Bearer ", ""])("rejects missing bearer credentials: %s", async (authorization) => {
  const req = { headers: { authorization } } as Request;
  const res = loginResponse();
  const next = jest.fn();
  await authenticateJWT(req, res as unknown as Response, next);
  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.send).toHaveBeenCalledWith("Token required");
  expect(verify).not.toHaveBeenCalled();
  expect(next).not.toHaveBeenCalled();
});

test("rejects an expired token without continuing", async () => {
  verify.mockImplementation((_token, _secret, callback) => {
    callback(Object.assign(new Error("jwt expired"), {
      name: "TokenExpiredError", inner: new Error("expired"), expiredAt: new Date(0),
    }));
  });
  const req = { headers: { authorization: "Bearer expired-token" } } as Request;
  const res = loginResponse();
  const next = jest.fn();
  await authenticateJWT(req, res as unknown as Response, next);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.send).toHaveBeenCalledWith("Invalid token");
  expect(req.user).toBeUndefined();
  expect(next).not.toHaveBeenCalled();
});

test("login rejects an unknown email without comparing passwords or signing", async () => {
  query.mockResolvedValue({ rows: [] });
  const res = loginResponse();
  await login(loginRequest(), res as unknown as Response);
  expect(query).toHaveBeenCalledWith(expect.any(String), ["learner@example.com"]);
  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.send).toHaveBeenCalledWith("Invalid credentials");
  expect(compare).not.toHaveBeenCalled();
  expect(sign).not.toHaveBeenCalled();
});

test("login rejects a wrong password without issuing a token", async () => {
  query.mockResolvedValue({ rows: [{ id: 42, password: "stored-hash" }] });
  compare.mockResolvedValue(false);
  const res = loginResponse();
  await login(loginRequest(), res as unknown as Response);
  expect(compare).toHaveBeenCalledWith("password123", "stored-hash");
  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.send).toHaveBeenCalledWith("Invalid credentials");
  expect(sign).not.toHaveBeenCalled();
});

test("login signs a one-hour token for the database user after password verification", async () => {
  query.mockResolvedValue({ rows: [{ id: 42, password: "stored-hash" }] });
  compare.mockResolvedValue(true);
  sign.mockReturnValue("signed-token");
  const req = loginRequest();
  req.body.userId = 999; // An identity supplied by the caller must not be signed.
  const res = loginResponse();
  await login(req, res as unknown as Response);
  expect(compare).toHaveBeenCalledWith("password123", "stored-hash");
  expect(sign).toHaveBeenCalledTimes(1);
  expect(sign).toHaveBeenCalledWith({ userId: 42 }, "unit-test-secret", {
    expiresIn: "1h", algorithm: "HS256",
  });
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.send).toHaveBeenCalledWith({ message: "Login successfull", token: "signed-token" });
});

test("login propagates database failures without issuing a token or success response", async () => {
  const error = new Error("database unavailable");
  query.mockRejectedValue(error);
  const res = loginResponse();
  await expect(login(loginRequest(), res as unknown as Response)).rejects.toBe(error);
  expect(compare).not.toHaveBeenCalled();
  expect(sign).not.toHaveBeenCalled();
  expect(res.send).not.toHaveBeenCalled();
});

test("login propagates signing failures without sending success", async () => {
  query.mockResolvedValue({ rows: [{ id: 42, password: "stored-hash" }] });
  compare.mockResolvedValue(true);
  const error = new Error("signing failed");
  sign.mockImplementation(() => { throw error; });
  const res = loginResponse();
  await expect(login(loginRequest(), res as unknown as Response)).rejects.toBe(error);
  expect(res.send).not.toHaveBeenCalled();
});


test("authentication fails closed when the signing secret is missing", async () => {
  // Reload only for this case: SECRET_KEY is captured when the module loads.
  const secret = process.env.SECRET_KEY;
  try {
    delete process.env.SECRET_KEY;
    jest.resetModules();
    const authWithoutSecret = await import("../auth/auth-jwt.ts");
    const req = { headers: { authorization: "Bearer valid-token" } } as Request;
    const res = loginResponse();
    const next = jest.fn();
    await expect(authWithoutSecret.authenticateJWT(req, res as unknown as Response, next))
      .rejects.toThrow("SECRET KEY is missing");
    expect(verify).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  } finally {
    if (secret === undefined) delete process.env.SECRET_KEY;
    else process.env.SECRET_KEY = secret;
  }
});
