import {
  pgTable,
  foreignKey,
  check,
  serial,
  varchar,
  customType,
  integer,
  bigint,
  timestamp,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import pg from "pg";

// Drizzle's built-in date mappers differ from node-postgres for these naive
// PostgreSQL types. Reuse the original parsers to preserve API dates/timezones.
const pgTimestamp = customType<{ data: Date; driverData: string }>({
  dataType: () => "timestamp",
  fromDriver: (value) => pg.types.getTypeParser(1114, "text")(value) as Date,
});
const pgDate = customType<{ data: Date; driverData: string }>({
  dataType: () => "date",
  fromDriver: (value) => pg.types.getTypeParser(1082, "text")(value) as Date,
});

export const projects = pgTable(
  "projects",
  {
    id: serial().primaryKey().notNull(),
    name: varchar({ length: 100 }).notNull(),
    description: varchar({ length: 255 }),
    status: varchar({ length: 100 }),
    createdAt: pgTimestamp("created_at").default(sql`CURRENT_TIMESTAMP`),
    userId: integer("user_id"),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    taskCacheVersion: bigint("task_cache_version", { mode: "bigint" })
    .default(sql`0`)
    .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: "fk_user",
    }),
    check(
      "projects_status_check",
      sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('inactive'::character varying)::text, ('pending'::character varying)::text, ('completed'::character varying)::text])`,
    ),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: serial().primaryKey().notNull(),
    title: varchar({ length: 50 }).notNull(),
    projectId: integer("project_id").notNull(),
    description: varchar({ length: 255 }),
    status: varchar({ length: 50 }).default("on progress"),
    createdAt: pgDate("created_at").default(sql`CURRENT_DATE`),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "tasks_project_id_fkey",
    }),
    check(
      "tasks_status_check",
      sql`(status)::text = ANY (ARRAY[('done'::character varying)::text, ('on progress'::character varying)::text, ('cancelled'::character varying)::text])`,
    ),
  ],
);

export const users = pgTable("users", {
  id: serial().primaryKey().notNull(),
  name: varchar({ length: 30 }),
  email: varchar({ length: 30 }),
  password: varchar({ length: 255 }).notNull(),
  role: varchar({ length: 50 }).default("user"),
  profilePicKey: varchar("profile_pic_key", { length: 255 }),
});

export const workspaces = pgTable("workspaces", {
  id: serial().primaryKey(),
  name: varchar({ length: 100 }).notNull(),
  createdBy: integer("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    role: varchar({
      length: 10,
      enum: ["owner", "editor", "viewer"],
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    check(
      "workspace_members_role_check",
      sql`${table.role} IN ('owner', 'editor', 'viewer')`,
    ),
    uniqueIndex("workspace_members_one_owner")
      .on(table.workspaceId)
      .where(sql`${table.role} = 'owner'`),
    index("workspace_members_user_idx").on(table.userId),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: serial().primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: varchar({ length: 254 }).notNull(),
    role: varchar({
      length: 10,
      enum: ["editor", "viewer"],
    }).notNull(),
    tokenHash: varchar("token_hash", { length: 64 })
      .notNull()
      .unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    invitedBy: integer("invited_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "invitations_role_check",
      sql`${table.role} IN ('editor', 'viewer')`,
    ),
    index("invitations_workspace_idx").on(table.workspaceId),
    index("invitations_invited_by_idx").on(table.invitedBy),
  ],
);