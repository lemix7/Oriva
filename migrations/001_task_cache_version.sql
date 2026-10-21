-- Store a separate task-cache version on every project.
ALTER TABLE projects
ADD COLUMN task_cache_version BIGINT NOT NULL DEFAULT 0;