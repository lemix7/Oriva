UPDATE "users"
SET "email" = lower(trim("email"))
WHERE "email" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower(trim("email")));
