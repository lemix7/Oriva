import { Router } from "express";
import * as db from "../controllers/projects.controller.ts";

const router = Router();

router.get("/", db.get_projects);
router.get("/:project_id", db.get_project_by_ID);
router.patch("/:project_id", db.update_project);
router.delete("/:project_id", db.delete_project);

export default router;
