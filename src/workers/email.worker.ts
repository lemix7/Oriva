import { Worker } from "bullmq";
import connection from "../config/redis.ts";
import newUserEmail, {
  sendInvitationEmail,
} from "../services/email.service.ts";

const emailWworker = new Worker(
  "emailQueue",
  async (job) => {
    if (!job.id) {
      throw new Error("Email job ID is missing");
    }

    const idempotencyKey = `${job.name}/${job.queueName}/${job.id}/${job.timestamp}`;

    if (job.name === "sendInvitationEmail") {
      return sendInvitationEmail(
        job.data.email,
        job.data.token,
        idempotencyKey,
      );
    }

    if (job.name === "sendEmail") {
      return newUserEmail(
        job.data.user_name,
        `registration/${job.queueName}/${job.id}/${job.timestamp}`,
      );
    }

    throw new Error("Unknown email job type");
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
