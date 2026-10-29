import express, { type Response, type Request, type Express } from "express";
import * as db from "../controllers/projects.controller.ts";
import createProjectValidator from "../validators/projects.validator.ts";
import messageProvider from "../validators/message-provider.ts";
import validate from "../middleware/validate.ts";

const router = express.Router();

router.get("/", db.get_projects);
router.get("/:project_id", db.get_project_by_ID);
router.post(
  "/",
  validate(createProjectValidator, messageProvider),
  db.create_project,
);
router.patch("/:project_id", db.update_project);
router.delete("/:project_id", db.delete_project);

export default router;
