import express, { type Response, type Request, type Express } from "express";
import * as db from "../contollers/tasks.controller.ts";
import messageProvider from "../validators/message-provider.ts";
import validate from "../middleware/validate.ts";
import createTaskValidator from "../validators/tasks.validator.ts";

const router = express.Router();

router.get("/:project_id/tasks", db.get_tasks);
router.get("/:project_id/tasks/:task_id", db.get_task_by_Id);
router.post(
  "/:project_id/tasks",
  validate(createTaskValidator, messageProvider),
  db.create_task,
);
router.patch("/:project_id/tasks/:task_id", db.update_task);
router.delete("/:project_id/tasks/:task_id", db.delete_task);

export default router;
