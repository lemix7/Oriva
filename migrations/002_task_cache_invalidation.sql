
BEGIN;

-- Define a function PostgreSQL will call after a task changes.
CREATE FUNCTION invalidate_project_tasks()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- NEW contains the task that was created.
    UPDATE projects
    SET task_cache_version = task_cache_version + 1
    WHERE id = NEW.project_id;

  ELSIF TG_OP = 'DELETE' THEN
    -- OLD contains the task that was deleted.
    UPDATE projects
    SET task_cache_version = task_cache_version + 1
    WHERE id = OLD.project_id;

  ELSE
    -- An update has both OLD and NEW values.
    -- If a task moves between projects, advance both versions.
    -- If it stays in the same project, that project advances once.
    UPDATE projects
    SET task_cache_version = task_cache_version + 1
    WHERE id IN (OLD.project_id, NEW.project_id);
  END IF;

  -- This AFTER trigger does not need to return a modified task.
  RETURN NULL;
END;
$$;

-- Connect the function to task inserts, updates, and deletes.
CREATE TRIGGER tasks_invalidate_project_cache
AFTER INSERT OR UPDATE OR DELETE ON tasks
FOR EACH ROW
EXECUTE FUNCTION invalidate_project_tasks();

COMMIT;