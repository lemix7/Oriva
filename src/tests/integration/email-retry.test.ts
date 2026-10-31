import { afterAll, beforeAll, beforeEach, expect, jest, test } from "@jest/globals";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Queue, QueueEvents, Worker } from "bullmq";

const send = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const originalApiKey = process.env.RESEND_API_KEY;
const originalEmailFrom = process.env.EMAIL_FROM;
let directory: string | undefined;
let redisProcess: ChildProcess | undefined;
let queue: Queue | undefined;
let events: QueueEvents | undefined;
let worker: Worker | undefined;
let logs: ReturnType<typeof jest.spyOn> | undefined;
let errors: ReturnType<typeof jest.spyOn> | undefined;

jest.unstable_mockModule("resend", () => ({
  Resend: class { emails = { send }; },
}));
jest.unstable_mockModule("dotenv", () => ({ default: { config: jest.fn() } }));

beforeAll(async () => {
  process.env.RESEND_API_KEY = "integration-test-resend-key";
  process.env.EMAIL_FROM = "Oriva <invite@test.local>";
  // A fresh socket-only Redis process ensures tests cannot reach application
  // queues or send real email. It never listens on a network port or saves data.
  directory = await mkdtemp(join(tmpdir(), "oriva-email-"));
  const socket = join(directory, "redis.sock");
  redisProcess = spawn(process.env.REDIS_SERVER_BINARY || "redis-server", [
    "--port", "0", "--unixsocket", socket, "--unixsocketperm", "700",
    "--save", "", "--appendonly", "no", "--dir", directory,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const child = redisProcess;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Isolated Redis did not become ready")), 8000);
    let output = "";
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Isolated Redis exited during startup (${code})`));
    });
    child.stdout?.on("data", (data) => {
      output += data.toString();
      if (/ready to accept connections/i.test(output)) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  jest.unstable_mockModule("../../config/redis.js", () => ({
    default: { path: socket, maxRetriesPerRequest: null },
  }));
  logs = jest.spyOn(console, "log").mockImplementation(() => {});
  errors = jest.spyOn(console, "error").mockImplementation(() => {});
  const { QueueEvents } = await import("bullmq");
  events = new QueueEvents("emailQueue", { connection: { path: socket } });
  await events.waitUntilReady();
  ({ default: queue } = await import("../../queue/email.que.ts"));
  ({ default: worker } = await import("../../workers/email.worker.ts"));
  await Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]);
});

beforeEach(() => { send.mockReset(); });

afterAll(async () => {
  try {
    await Promise.all([worker?.close(), events?.close(), queue?.close()]);
  } finally {
    if (originalApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalApiKey;
    if (originalEmailFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = originalEmailFrom;
    logs?.mockRestore();
    errors?.mockRestore();
    if (redisProcess && redisProcess.exitCode === null && redisProcess.signalCode === null) {
      const exited = once(redisProcess, "exit");
      redisProcess.kill("SIGTERM");
      await exited;
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

const temporaryFailure = {
  data: null,
  error: { name: "application_error", statusCode: 503, message: "Temporary provider failure" },
};

function keysUsed() {
  return send.mock.calls.map((call) => (call[1] as { idempotencyKey: string }).idempotencyKey);
}

test("invitation jobs recover with one key, route to the recipient, and remove completed secrets", async () => {
  send.mockResolvedValueOnce(temporaryFailure)
    .mockResolvedValue({ data: { id: "invitation-delivered" }, error: null });
  const { queueInvitationEmail } = await import("../../services/invitation-delivery.service.ts");
  await queueInvitationEmail(701, "sara@test.local", "test-only-invitation-token");
  const job = await queue!.getJob("invitation-701");
  expect(job).toBeDefined();
  expect(job!.opts).toMatchObject({
    attempts: 3, removeOnComplete: true, removeOnFail: { age: 86400 },
  });
  await job!.waitUntilFinished(events!, 10000);
  expect(send).toHaveBeenCalledTimes(2);
  expect(keysUsed()).toEqual(Array(2).fill(
    `sendInvitationEmail/emailQueue/${job!.id}/${job!.timestamp}`,
  ));
  expect(send.mock.calls[0]![0]).toMatchObject({
    to: "sara@test.local", text: expect.stringContaining("test-only-invitation-token"),
  });
  expect(await queue!.getJob(job!.id!)).toBeUndefined();
  expect(JSON.stringify(logs!.mock.calls)).not.toContain("test-only-invitation-token");
});

test("invitation permanent failures stop after one worker attempt", async () => {
  send.mockResolvedValue({ data: null, error: {
    name: "validation_error", statusCode: 422, message: "Invalid recipient",
  } });
  const job = await queue!.add("sendInvitationEmail", {
    email: "sara@test.local", token: "test-only-invitation-token",
  });
  await expect(job.waitUntilFinished(events!, 10000)).rejects.toThrow("Invalid recipient");
  expect(send).toHaveBeenCalledTimes(1);
  expect((await queue!.getJob(job.id!))!.attemptsMade).toBe(1);
});

test("temporary failures use three attempts, exponential delays, and one idempotency key", async () => {
  const times: number[] = [];
  send.mockImplementation(async () => { times.push(performance.now()); return temporaryFailure; });
  const job = await queue!.add("sendEmail", { user_name: "Retry fixture" });
  expect(job.opts).toMatchObject({ attempts: 3, backoff: { type: "exponential", delay: 1000 } });

  await expect(job.waitUntilFinished(events!, 10000)).rejects.toThrow("Temporary provider failure");

  const saved = await queue!.getJob(job.id!);
  expect(await saved!.getState()).toBe("failed");
  expect(saved!.attemptsMade).toBe(3);
  expect(send).toHaveBeenCalledTimes(3);
  expect(keysUsed()).toEqual(Array(3).fill(
    `registration/emailQueue/${job.id}/${job.timestamp}`,
  ));
  // Allow scheduling variation; there is no tight upper timing bound.
  expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(900);
  expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(1900);
});

test("permanent provider errors stay failed after one attempt despite the retry policy", async () => {
  send.mockResolvedValue({
    data: null,
    error: { name: "validation_error", statusCode: 401, message: "Invalid API key" },
  });
  const job = await queue!.add("sendEmail", { user_name: "Permanent failure fixture" });

  await expect(job.waitUntilFinished(events!, 10000)).rejects.toThrow("Invalid API key");

  const saved = await queue!.getJob(job.id!);
  expect(await saved!.getState()).toBe("failed");
  expect(saved!.attemptsMade).toBe(1);
  expect(send).toHaveBeenCalledTimes(1);
});

test("a recovered job completes on the next attempt and reuses the original request key", async () => {
  send.mockResolvedValueOnce(temporaryFailure)
    .mockResolvedValue({ data: { id: "mock-email-id" }, error: null });
  const job = await queue!.add("sendEmail", { user_name: "Recovery fixture" });

  await job.waitUntilFinished(events!, 10000);

  const saved = await queue!.getJob(job.id!);
  expect(await saved!.getState()).toBe("completed");
  expect(saved!.attemptsMade).toBe(2);
  expect(send).toHaveBeenCalledTimes(2);
  expect(new Set(keysUsed()).size).toBe(1);
  expect(send.mock.calls[0]![0]).toEqual(send.mock.calls[1]![0]);
});
