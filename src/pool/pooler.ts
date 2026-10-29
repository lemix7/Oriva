import pg from "pg";
import { requiredEnv } from "../config/env.ts";

const { Pool } = pg;

const pool = new Pool({
  connectionString: requiredEnv("DATABASE_URL"),
});

export default pool;