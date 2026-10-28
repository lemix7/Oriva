import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import pg from "pg";

// Keep the application's existing local database and AWS settings separate.
let fileEnv = {};
try {
  fileEnv = dotenv.parse(await readFile(new URL("../.env.neon", import.meta.url)));
} catch (error) {
  if (error.code !== "ENOENT") throw new Error("Could not read .env.neon");
}

const connectionString = process.env.NEON_SMOKE_DATABASE_URL
  || fileEnv.DATABASE_URL_UNPOOLED
  || fileEnv.DATABASE_URL;

let pool;
let client;
try {
  if (!connectionString) {
    throw new Error("Set NEON_SMOKE_DATABASE_URL or put a Neon connection string in .env.neon.");
  }
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("The smoke-test connection string is invalid.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)
      || !url.hostname.endsWith(".neon.tech")) {
    throw new Error("This smoke test requires a Neon database hostname ending in .neon.tech.");
  }
  if (!["require", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode"))) {
    throw new Error("Keep the SSL settings from the Neon-provided connection string.");
  }

  pool = new pg.Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 20_000,
    statement_timeout: 15_000,
  });
  client = await pool.connect();
  await client.query("BEGIN");
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.neon_setup_smoke (
      id uuid PRIMARY KEY,
      message text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const id = randomUUID();
  const message = "Hello from Oriva on Lakebase Postgres!";
  await client.query(
    "INSERT INTO public.neon_setup_smoke (id, message) VALUES ($1, $2)",
    [id, message],
  );
  const result = await client.query(
    "SELECT id, message, created_at FROM public.neon_setup_smoke WHERE id = $1",
    [id],
  );
  if (result.rows.length !== 1 || result.rows[0].message !== message) {
    throw new Error("The inserted row could not be verified.");
  }
  await client.query("COMMIT");
  console.log("PASS: created table, inserted one row, and read it back.");
  console.log(JSON.stringify(result.rows[0], null, 2));
} catch (error) {
  if (client) await client.query("ROLLBACK").catch(() => {});
  // Driver errors can contain connection details; print only a safe code.
  console.error(error instanceof Error && !pool
    ? error.message
    : `Neon smoke test failed (${typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "DATABASE_ERROR"}).`);
  process.exitCode = 1;
} finally {
  client?.release();
  await pool?.end();
}
