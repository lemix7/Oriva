import dotenv from "dotenv";
import pg from "pg";
import bcrypt from "bcryptjs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, sql } from "drizzle-orm";
import { projects, tasks, users } from "../src/db/schema.ts";

export function seedDatabaseUrl(connectionString: string | undefined): string {
  if (!connectionString) throw new Error("TEST_DATABASE_URL is required");
  const url = new URL(connectionString);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.searchParams.has("host") || url.searchParams.has("hostaddr")
  ) {
    throw new Error("Seeding requires local PostgreSQL");
  }
  url.pathname = "/oriva_migration_test";
  return url.href;
}

// Reuse existing demo records so reruns preserve local edits and passwords.
export async function seedDemo(db: Pick<NodePgDatabase, "transaction">): Promise<void> {
  await db.transaction(async (tx) => {
    // Serialize seed runs: email and project names currently have no unique constraints.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(71342, 1)`);
    const email = "demo.owner@example.com";
    const createdAt = new Date("2026-01-01T00:00:00Z");

    const [existingUser] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    let ownerId = existingUser?.id;
    if (ownerId === undefined) {
      const [createdUser] = await tx.insert(users).values({
        name: "Demo Owner",
        email,
        password: await bcrypt.hash("LocalDemo123!", 10),
        role: "user",
      }).returning({ id: users.id });
      ownerId = createdUser.id;
    }

    const [existingProject] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.userId, ownerId), eq(projects.name, "Demo Project")))
      .limit(1);

    let projectId = existingProject?.id;
    if (projectId === undefined) {
      const [createdProject] = await tx.insert(projects).values({
        name: "Demo Project",
        description: "Local demo project",
        status: "active",
        userId: ownerId,
        createdAt,
      }).returning({ id: projects.id });
      projectId = createdProject.id;
    }

    const demoTasks = [
      { title: "Plan the project", status: "done" },
      { title: "Build the first feature", status: "on progress" },
    ];

    for (const task of demoTasks) {
      const [existingTask] = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.projectId, projectId), eq(tasks.title, task.title)))
        .limit(1);

      if (!existingTask) {
        await tx.insert(tasks).values({
          ...task,
          projectId,
          description: "Local demo task",
          createdAt,
        });
      }
    }
  });
}

async function main(): Promise<void> {
  dotenv.config({ path: ".env.test", quiet: true });
  const client = new pg.Client({
    connectionString: seedDatabaseUrl(process.env.TEST_DATABASE_URL),
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    await seedDemo(drizzle({ client }));
    console.log("Local demo owner, project, and two tasks are ready");
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("Local demo seed failed. Check local PostgreSQL, .env.test, and migrations.");
    process.exitCode = 1;
  });
}
