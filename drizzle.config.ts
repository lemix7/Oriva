import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

dotenv.config({ path: ".env.neon" });

const url =
  process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL_UNPOOLED;

if (!url) {
  throw new Error(
    "MIGRATION_DATABASE_URL or DATABASE_URL_UNPOOLED is required",
  );
}

export default defineConfig({
  dialect: "postgresql",
  out: "./drizzle",
  tablesFilter: [
    "users",
    "projects",
    "tasks",
    "workspaces",
    "workspace_members",
  ],
  dbCredentials: { url },
  schema: "./src/db/schema.ts",
});
