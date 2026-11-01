import vine from "@vinejs/vine";

const updateProjectSchema = vine.object({
  name: vine.string().trim().minLength(3).maxLength(100).optional(),
  description: vine.string().maxLength(255).nullable().optional(),
  status: vine.enum(["active", "inactive", "pending", "completed"]).optional(),
});

export const updateProjectValidator = vine.compile(updateProjectSchema);
