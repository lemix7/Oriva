-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations

CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" varchar(255),
	"status" varchar(100),
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
	"user_id" integer,
	"task_cache_version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "projects_status_check" CHECK ((status)::text = ANY (ARRAY[('active'::character varying)::text, ('inactive'::character varying)::text, ('pending'::character varying)::text, ('completed'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" varchar(50) NOT NULL,
	"project_id" integer NOT NULL,
	"description" varchar(255),
	"status" varchar(50) DEFAULT 'on progress',
	"created_at" date DEFAULT CURRENT_DATE,
	CONSTRAINT "tasks_status_check" CHECK ((status)::text = ANY (ARRAY[('done'::character varying)::text, ('on progress'::character varying)::text, ('cancelled'::character varying)::text]))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(30),
	"email" varchar(30),
	"password" varchar(255) NOT NULL,
	"role" varchar(50) DEFAULT 'user',
	"profile_pic_key" varchar(255)
);
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "fk_user" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
