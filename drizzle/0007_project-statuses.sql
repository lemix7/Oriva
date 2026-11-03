CREATE TABLE "project_statuses" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" varchar(50) NOT NULL,
	"position" integer NOT NULL,
	"is_done" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "status_id" integer;--> statement-breakpoint
ALTER TABLE "project_statuses" ADD CONSTRAINT "project_statuses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_statuses_project_name_unique" ON "project_statuses" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "project_statuses_id_project_unique" ON "project_statuses" USING btree ("id","project_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_project_fk" FOREIGN KEY ("status_id","project_id") REFERENCES "public"."project_statuses"("id","project_id") ON DELETE restrict ON UPDATE no action;

--> statement-breakpoint
INSERT INTO "project_statuses"
  ("project_id", "name", "position", "is_done")
SELECT
  p.id,
  defaults.name,
  defaults.position,
  defaults.is_done
FROM "projects" AS p
CROSS JOIN (
  VALUES
    ('Backlog',     1000, false),
    ('In Progress', 2000, false),
    ('Review',      3000, false),
    ('Done',        4000, true)
) AS defaults(name, position, is_done);