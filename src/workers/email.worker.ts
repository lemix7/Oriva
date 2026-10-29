import { Worker } from "bullmq";
import connection from "../config/redis.ts";
import newUserEmail from "../services/email.service.ts";

const emailWworker = new Worker(
  "emailQueue",
  async (job) => {
    try {
      const { user_name } = job.data;
      console.log(
        `Sending email to ahmedgeger@gmail.com about the joing of ${user_name}`,
      );

      if (!job.id) {
        throw new Error("Email job ID is missing");
      }

      const result = await newUserEmail(
        user_name,
        `registration/${job.queueName}/${job.id}/${job.timestamp}`,
      );

      if (!result) {
        throw new Error("Email delivery failed");
      }
    } catch (error) {
      console.error(`Failed to send email about ${job.data.user_name}`);
      throw error instanceof Error ? error : new Error("Email job failed");
    }
  },
  { connection },
);

emailWworker.on("completed", (job) => {
  console.log(`job completed with id ${job.id}`);
});
emailWworker.on("failed", (job, err) => {
  console.log(`job completed with id ${job?.id} and error : ${err.message}`);
});

export default emailWworker;
