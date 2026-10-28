import { afterAll, beforeAll, beforeEach, expect, jest, test } from "@jest/globals";
import { createServer, type Server } from "node:http";
import express from "express";
import requestId from "../../middleware/request-id.ts";
import logger from "../../middleware/logger.ts";
import errorHandling from "../../middleware/error-handling.ts";
import parseProfile from "../../middleware/parse-profile.ts";
import loginRateLimit from "../../middleware/login-rate-limit.ts";

let server: Server | undefined;
let baseUrl: string;
const requestLog = jest.spyOn(console, "log").mockImplementation(() => {});
const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

beforeAll(async () => {
  // Exercise the production middleware without database, Redis, or cloud clients.
  const app = express();
  app.use(requestId);
  app.use(logger);
  app.use(express.json());
  app.post("/login", loginRateLimit, (_req, res) => {
    res.status(401).json({ message: "Invalid credentials" });
  });
  app.get("/health", (_req, res) => { res.sendStatus(200); });
  app.post("/upload", parseProfile.single("profilePic"), (_req, res) => {
    res.status(201).json({ ok: true });
  });
  const projects = express.Router();
  projects.post("/:id/tasks", (_req, res) => { res.status(201).json({ ok: true }); });
  app.use("/projects", projects);
  app.get("/failure", () => { throw new Error("test-only-sensitive-error"); });
  app.use(errorHandling);
  server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server has no TCP address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => { requestLog.mockClear(); errorLog.mockClear(); });

afterAll(async () => {
  try {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve());
      });
    }
  } finally {
    requestLog.mockRestore();
    errorLog.mockRestore();
  }
});

test("malformed JSON returns 400 with the same server-generated ID in header, body, and log", async () => {
  const response = await fetch(`${baseUrl}/projects/7/tasks?token=test-query-secret`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": "untrusted-client-id" },
    body: '{"password":"test-body-secret",',
    signal: AbortSignal.timeout(5000),
  });
  const id = response.headers.get("x-request-id");
  expect(response.status).toBe(400);
  expect(id).toMatch(uuid);
  expect(id).not.toBe("untrusted-client-id");
  expect(await response.json()).toEqual({ success: false, message: "Invalid JSON", requestId: id });
  expect(requestLog).toHaveBeenCalledTimes(1);
  const entry = JSON.parse(requestLog.mock.calls[0]![0]);
  expect(entry).toMatchObject({ requestId: id, method: "POST", path: "/projects/7/tasks", status: 400 });
  expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  expect(errorLog).not.toHaveBeenCalled();
  expect(JSON.stringify(requestLog.mock.calls)).not.toContain("test-query-secret");
  expect(JSON.stringify(requestLog.mock.calls)).not.toContain("test-body-secret");
});

test("mounted routes retain their full path in logs and every request gets a distinct ID", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${baseUrl}/projects/7/tasks?token=test-query-secret`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-header-secret" },
      body: JSON.stringify({ password: "test-body-secret" }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(201);
    await response.json();
    const id = response.headers.get("x-request-id")!;
    expect(id).toMatch(uuid);
    ids.push(id);
  }
  expect(new Set(ids).size).toBe(2);
  expect(requestLog).toHaveBeenCalledTimes(2);
  requestLog.mock.calls.forEach(([line], i) => {
    expect(JSON.parse(line)).toMatchObject({
      requestId: ids[i], method: "POST", path: "/projects/7/tasks", status: 201,
    });
  });
  const logged = JSON.stringify(requestLog.mock.calls);
  for (const secret of ["test-query-secret", "test-header-secret", "test-body-secret"]) {
    expect(logged).not.toContain(secret);
  }
});

test("unexpected failures correlate logs and responses without exposing the error message", async () => {
  const response = await fetch(`${baseUrl}/failure`, { signal: AbortSignal.timeout(5000) });
  const id = response.headers.get("x-request-id");
  expect(response.status).toBe(500);
  const body = await response.json();
  expect(body).toEqual({ success: false, message: "Internal server error", requestId: id });
  expect(JSON.parse(errorLog.mock.calls[0]![0])).toMatchObject({ requestId: id, status: 500 });
  expect(JSON.parse(requestLog.mock.calls[0]![0])).toMatchObject({ requestId: id, status: 500 });
  expect(JSON.stringify([body, errorLog.mock.calls, requestLog.mock.calls]))
    .not.toContain("test-only-sensitive-error");
});

test("an oversized multipart upload returns 413 with its request ID", async () => {
  const form = new FormData();
  form.append("profilePic", new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], {
    type: "image/png",
  }), "profile.png");

  const response = await fetch(`${baseUrl}/upload`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(5000),
  });

  const id = response.headers.get("x-request-id");
  expect(id).toMatch(uuid);
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({
    success: false,
    message: "Profile picture must be 5 MB or smaller",
    requestId: id,
  });
  expect(errorLog).not.toHaveBeenCalled();
  expect(requestLog).toHaveBeenCalledTimes(1);
  expect(JSON.parse(requestLog.mock.calls[0]![0])).toMatchObject({
    requestId: id, method: "POST", path: "/upload", status: 413,
  });
});

test("login is limited after ten attempts without limiting other routes", async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await fetch(`${baseUrl}/login`, {
      method: "POST", signal: AbortSignal.timeout(5000),
    });
    await response.json();
    expect(response.status).toBe(401);
  }

  const blocked = await fetch(`${baseUrl}/login`, {
    method: "POST", signal: AbortSignal.timeout(5000),
  });
  expect(blocked.status).toBe(429);
  expect(await blocked.json()).toEqual({
    success: false,
    message: "Too many login attempts. Try again later.",
    requestId: blocked.headers.get("x-request-id"),
  });
  expect(blocked.headers.get("x-request-id")).toMatch(uuid);
  expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(Number(blocked.headers.get("retry-after"))).toBeLessThanOrEqual(900);
  expect(blocked.headers.get("ratelimit")).not.toBeNull();

  const otherRoute = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
  await otherRoute.text();
  expect(otherRoute.status).toBe(200);
  expect(errorLog).not.toHaveBeenCalled();
});
