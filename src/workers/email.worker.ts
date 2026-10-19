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

      await newUserEmail(user_name);
    } catch (error) {
      console.error(`Failed to send email about ${job.data.user_name}`);
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
