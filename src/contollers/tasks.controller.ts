import express, { type Request, type Response, type Express } from "express";
import * as taskRepository from "../repositories/task.repository.ts";
import { getCachedTasks } from "../services/task-cache.service.ts";

const get_tasks = async (req: Request, res: Response) => {
  if (!req.user || typeof req.user === "string") {
    return res.status(401).send("Unauthorized");
  }
  const userId = req.user.userId;
  const projectId = req.params.project_id;

  const tasks = await getCachedTasks(userId, projectId);

  if (tasks.length == 0) {
    return res.status(200).send([]);
  }
  res.status(200).json(tasks);
};

const get_task_by_Id = async (req: Request, res: Response) => {
  if (!req.user || typeof req.user === "string") {
    return res.status(401).send("Unauthorized");
  }
  const userId = req.user.userId;
  const projectId = req.params.project_id;
  const taskId = req.params.task_id;
  const tasks = await taskRepository.findTaskForUser(userId, projectId, taskId);
  res.status(200).json(tasks);
};

const create_task = async (req: Request, res: Response) => {
  if (!req.user || typeof req.user === "string") {
    return res.status(401).send("Unauthorized");
  }
  const userId = req.user.userId;
  const projectId = req.params.project_id;
  const { title, description, status } = req.body;
  const project = await taskRepository.findOwnedProject(projectId, userId);

  if (!project) {
    return res.status(403).json({
      message: "Project not found",
    });
  }

  const tasks = await taskRepository.insertTask(
    title,
    description,
    status,
    projectId,
  );
  res.status(200).json(tasks);
};

const update_task = async (req: Request, res: Response) => {
  const projectId = req.params.project_id;
  if (!req.user || typeof req.user === "string") {
    return res.status(401).send("Unauthorized");
  }
  const userId = req.user.userId;
  const taskId = req.params.task_id;
  const update = "done";
  const updated = await taskRepository.updateTaskForUser(
    update,
    taskId,
    userId,
    projectId,
  );

  if (!updated) {
    return res.status(404).json({ message: "Task not found" });
  }

  res.status(200).json("task is updated to done");
};

const delete_task = async (req: Request, res: Response) => {
  if (!req.user || typeof req.user === "string") {
    return res.status(401).send("Unauthorized");
  }
  const userId = req.user.userId;
  const projectId = req.params.project_id;
  const taskId = req.params.task_id;
  await taskRepository.deleteTaskForUser(userId, projectId, taskId);
  res.status(200).json("task is deleted");
};

export { get_tasks, get_task_by_Id, create_task, update_task, delete_task };
