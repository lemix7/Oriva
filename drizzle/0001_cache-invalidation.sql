-- Advance the affected projects' cache versions after a task changes.
CREATE FUNCTION invalidate_project_tasks()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE projects
    SET task_cache_version = task_cache_version + 1
    WHERE id = NEW.project_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE projects
    SET task_cache_version = task_cache_version + 1
    WHERE id = OLD.project_id;
  ELSE
    UPDATE projects
    SET task_cache_version = task_cache_version + 1
    WHERE id IN (OLD.project_id, NEW.project_id);
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tasks_invalidate_project_cache
AFTER INSERT OR UPDATE OR DELETE ON tasks
FOR EACH ROW
EXECUTE FUNCTION invalidate_project_tasks();
--> statement-breakpoint
-- Advance the cache version before saving any project update.
CREATE FUNCTION bump_project_task_cache_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.task_cache_version := OLD.task_cache_version + 1;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER projects_task_cache_version
BEFORE UPDATE ON projects
FOR EACH ROW
EXECUTE FUNCTION bump_project_task_cache_version();
