import vine from "@vinejs/vine";

const updateWorkspaceTaskSchema = vine.object({
  title: vine.string().trim().minLength(3).maxLength(50).optional(),
  description: vine.string().maxLength(255).nullable().optional(),
  status: vine
    .enum(["done", "cancelled", "on progress"])
    .optional(),
});

export const updateWorkspaceTaskValidator =
  vine.compile(updateWorkspaceTaskSchema);