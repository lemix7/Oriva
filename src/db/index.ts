import { drizzle } from "drizzle-orm/node-postgres";
import pool from "../pool/pooler.ts";
import * as tables from "./schema.ts";
import * as relations from "./relations.ts";

export const db = drizzle({
  client: pool,
  schema: { ...tables, ...relations },
});