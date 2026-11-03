import vine from "@vinejs/vine";

export const updateProjectStatusValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(50).optional(),
    position: vine
      .number()
      .withoutDecimals()
      .min(0)
      .max(2147483647)
      .optional(),
    isDone: vine.boolean().optional(),
  }),
);