import vine from "@vinejs/vine";

const createWorkspaceTaskSchema = vine.object({
  title: vine.string().trim().minLength(3).maxLength(50),
  description: vine.string().maxLength(255).optional(),
  status: vine.enum(["done", "cancelled", "on progress"]),
});

export const createWorkspaceTaskValidator =
  vine.compile(createWorkspaceTaskSchema);