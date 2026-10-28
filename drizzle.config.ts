import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

dotenv.config({ path: ".env.neon" });

const url = process.env.DATABASE_URL_UNPOOLED;

if (!url) {
  throw new Error("DATABASE_URL_UNPOOLED is missing");
}

export default defineConfig({
  dialect: "postgresql",
  out: "./drizzle",
  tablesFilter: ["users", "projects", "tasks"],
  dbCredentials: { url },
  schema: "./src/db/schema.ts",
});
