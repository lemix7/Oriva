import emailQueue from "../queue/email.que.ts";

export async function queueInvitationEmail(
  invitationId: number,
  email: string,
  token: string,
) {
  await emailQueue.add(
    "sendInvitationEmail",
    { invitationId, email, token },
    {
      jobId: `invitation-${invitationId}`,
      removeOnComplete: true,
      removeOnFail: { age: 24 * 60 * 60 },
    },
  );
}

