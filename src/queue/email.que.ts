import { Queue } from "bullmq";
import connection from "../config/redis.ts";

const emailQueue = new Queue("emailQueue", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
  },
});

export default emailQueue;