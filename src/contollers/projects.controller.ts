import experss, { type Response, type Request, type Express } from "express";
import {
  getAllProject,
  updateProject,
  getProjectsByUserId,
  createProject,
  deleteProject,
} from "../repositories/project.repository.ts";

const get_projects = async (req: Request, res: Response) => {
  if (!req.user || typeof req.user === "string") {
    return res.status(401).send("Unauthorized");
  }
  const userId = req.user.userId;
  const projects = await getAllProject(userId);

  return res.status(200).json(projects);
};

const get_project_by_ID = async (req: Request, res: Response) => {
  if (!req.user || typeof req.user === "string") {
    return res.status(401).send("Unauthorized");
  }
  const userId = req.user.userId;

  const projectId = Number(req.params.project_id);

  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ message: "Invalid project ID" });
  }

  const project = await getProjectsByUserId(userId, projectId);
  if (!project) {
    return res.status(404).json({ message: "Project not found" });
  }
  return res.status(200).json(project);
};

const create_project = async (req: Request, res: Response) => {
  if (!req.user || typeof req.user === "string") {
    return res.status(401).send("Unauthorized");
  }
  const userId = req.user.userId;
  const { name, description, status } = res.locals.validatedData;

  const project = await createProject(name, description, status, userId);

  res.status(201).json(project);
};

const update_project = async (req: Request, res: Response) => {
  if (!req.user || typeof req.user === "string") {
    return res.status(401).send("Unauthorized");
  }
  const userId = req.user.userId;
  const project_id = Number(req.params.project_id);

  if (!Number.isInteger(project_id) || project_id <= 0) {
    return res.status(400).json({ message: "Invalid project ID" });
  }

  const c = "completed";
  const updatedProject = await updateProject(c, project_id, userId);
  if (!updatedProject) {
    return res.status(404).json({ message: "Project not found" });
  }
  res.status(200).json("project status updated");
};

const delete_project = async (req: Request, res: Response) => {
  if (!req.user || typeof req.user === "string") {
    return res.status(401).send("Unauthorized");
  }
  const userId = req.user.userId;
  const project_id = Number(req.params.project_id);

  if (!Number.isInteger(project_id) || project_id <= 0) {
    return res.status(400).json({ message: "Invalid project ID" });
  }

  const deletedProject = await deleteProject(userId, project_id);
  if (!deletedProject) {
    return res.status(404).json({ message: "Project not found" });
  }
  res.status(200).json("project is deleted");
};

export {
  get_projects,
  get_project_by_ID,
  create_project,
  update_project,
  delete_project,
};
