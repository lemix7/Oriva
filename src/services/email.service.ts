import { Resend } from "resend";
import dotenv from "dotenv";
import { UnrecoverableError } from "bullmq";

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);

const newUserEmail = async function (
  user_name: string,
  idempotencyKey: string,
) {
  const email = "ahmedgeger@gmail.com";
  const from = "My App <onboarding@resend.dev>";
  const safeUserName = user_name.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character]!;
  });

  const payload = {
    from,
    to: email,
    subject: "New user registration notification",
    html: `
      <h1>New user registered</h1>
      <p>Hello Ahmad,</p>
      <p>A new user, <strong>${safeUserName}</strong>, has successfully created an account in your application.</p>
      <p>This is an automated notification for your records. No action is required.</p>
      <p>Best regards,<br />My App Notifications</p>
    `,
  };

  const { data, error } = await resend.emails.send(payload, {
    signal: AbortSignal.timeout(5000),
    idempotencyKey,
  });

  if (error) {
    const retryable =
      error.statusCode === null ||
      error.statusCode === 408 ||
      error.name === "rate_limit_exceeded" ||
      error.name === "concurrent_idempotent_requests" ||
      (error.statusCode !== null && error.statusCode >= 500);

    if (!retryable) {
      throw new UnrecoverableError(error.message);
    }

    throw new Error(error.message);
  }

  if (!data) {
    throw new Error("Email provider returned no result");
  }

  return data;
};

export default newUserEmail;
