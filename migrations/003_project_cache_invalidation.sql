BEGIN;

-- Advance the version before saving any project update.
CREATE FUNCTION bump_project_task_cache_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.task_cache_version := OLD.task_cache_version + 1;
  RETURN NEW;
END;
$$;

-- Run the function whenever a project row is updated.
CREATE TRIGGER projects_task_cache_version
BEFORE UPDATE ON projects
FOR EACH ROW
EXECUTE FUNCTION bump_project_task_cache_version();

COMMIT;