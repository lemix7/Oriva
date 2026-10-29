import vine from "@vinejs/vine";

const createWorkspaceSchema = vine.object({
  name: vine.string().trim().minLength(1).maxLength(100),
});

export const createWorkspaceValidator =
  vine.compile(createWorkspaceSchema);