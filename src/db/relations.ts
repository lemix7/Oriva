import { relations } from "drizzle-orm/relations";
import { users, projects, tasks } from "./schema.ts";

export const projectsRelations = relations(projects, ({one, many}) => ({
	user: one(users, {
		fields: [projects.userId],
		references: [users.id]
	}),
	tasks: many(tasks),
}));

export const usersRelations = relations(users, ({many}) => ({
	projects: many(projects),
}));

export const tasksRelations = relations(tasks, ({one}) => ({
	project: one(projects, {
		fields: [tasks.projectId],
		references: [projects.id]
	}),
}));