import { readMigrationFiles } from "drizzle-orm/migrator";
import dotenv from "dotenv";
import pg from "pg";

// this file sync drizzle migration with the one exist in neon

const migrations = readMigrationFiles({
  migrationsFolder: "./drizzle",
});

if (migrations.length !== 2) {
  throw new Error("Expected exactly two baseline migrations");
}

dotenv.config({ path: ".env.neon", quiet: true });

const connectionString = process.env.DATABASE_URL_UNPOOLED;
if (!connectionString) throw new Error("Direct Neon URL is required");

const client = new pg.Client({ connectionString });

try {
    await client.connect();
    await client.query("BEGIN");
  
    await client.query("CREATE SCHEMA IF NOT EXISTS drizzle");
  
    await client.query(`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash TEXT NOT NULL,
        created_at BIGINT
      )
    `);
  
    await client.query(`
      LOCK TABLE drizzle.__drizzle_migrations IN EXCLUSIVE MODE
    `);
  
    const existing = await client.query(`
      SELECT hash, created_at
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at
    `);
  
    if (existing.rows.length === 0) {
      for (const migration of migrations) {
        await client.query(
          `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
           VALUES ($1, $2)`,
          [migration.hash, migration.folderMillis],
        );
      }
    } else {
      const matches =
        existing.rows.length === migrations.length &&
        existing.rows.every((row, index) =>
          row.hash === migrations[index].hash &&
          Number(row.created_at) === migrations[index].folderMillis
        );
  
      if (!matches) {
        throw new Error("Existing migration history does not match");
      }
    }
  
    await client.query("COMMIT");
    console.log("Neon baseline is registered");
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    throw new Error("Baseline failed; check the connection and migration history");
  } finally {
    await client.end();
  }