import vine from "@vinejs/vine";

export const createProjectStatusValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(50),
    isDone: vine.boolean().optional(),
  }),
);
    