import { Worker } from "bullmq";
import connection from "../config/redis.ts";
import newUserEmail, {
  sendInvitationEmail,
  sendPasswordResetEmail,
} from "../services/email.service.ts";
import { findPasswordResetTokenByHash } from "../repositories/password-reset-repository.ts";
import { hashPasswordResetToken } from "../shared/password-reset-token.ts";
import { requestPasswordReset } from "../services/password-reset.service.ts";

const emailWworker = new Worker(
  "emailQueue",
  async (job) => {
    if (!job.id) {
      throw new Error("Email job ID is missing");
    }

    const idempotencyKey = `${job.name}/${job.queueName}/${job.id}/${job.timestamp}`;

    if (job.name === "requestPasswordReset") {
      await requestPasswordReset(job.data.email);
      return;
    }

    if (job.name === "sendPasswordResetEmail") {
      const tokenHash = hashPasswordResetToken(job.data.token);
      const resetToken = await findPasswordResetTokenByHash(tokenHash);

      if (
        !resetToken ||
        resetToken.usedAt !== null ||
        resetToken.expiresAt <= new Date()
      ) {
        return;
      }

      return sendPasswordResetEmail(
        job.data.email,
        job.data.token,
        idempotencyKey,
      );
    }

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
