import { Resend } from "resend";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { setTimeout as delay } from "node:timers/promises";

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);

const newUserEmail = async function (user_name: string) {
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

  const base_delay = 1000;
  const max_retries = 4;
  const max_wait = 30_000;
  const idempotencyKey = randomUUID();
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

  try {
    for (let attempt = 0; attempt <= max_retries; attempt++) {
      const signal = AbortSignal.timeout(5000);
      const { data, error, headers } = await resend.emails.send(payload, {
        signal,
        idempotencyKey,
      });

      if (!error) {
        return data;
      }

      console.error(`Email attempt ${attempt + 1} failed:`, error.message);

      const retryable =
        (error.statusCode === null &&
          (signal.aborted || error.name === "application_error")) ||
        error.statusCode === 429 ||
        (error.statusCode !== null && error.statusCode >= 500);

      // when to not retry
      if (!retryable || attempt === max_retries) {
        return null;
      }

      let wait_time = base_delay * 2 ** attempt;

      // when to stop
      if (wait_time > max_wait) {
        console.error(
          "Email retry delay exceeds the limit; skipping notification.",
        );
        return null;
      }

      await delay(wait_time);
    }
  } catch (error) {
    console.error("Email service failed", error);
  }

  return null;
};

export default newUserEmail;
