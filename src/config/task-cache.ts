import { Redis } from "ioredis";
import connection from "./redis.ts";

// Create a dedicated connection for task caching.
const taskCache = new Redis({
  ...connection,

  // Start connecting when the first Redis command is issued.
  lazyConnect: false,

  // Reject commands while disconnected instead of holding them in a queue.
  enableOfflineQueue: false,

  // Don't retry individual failed commands.
  maxRetriesPerRequest: 0,

  // Limit connection and command waiting to 500 milliseconds.
  connectTimeout: 500,
  commandTimeout: 500,

  // Reconnect in the background, with delays up to 5 seconds.
  retryStrategy: times => Math.min(times * 200, 5000),
});


taskCache.on("error", error => {
  console.error("Task cache connection error:", error.message);
});

export default taskCache;