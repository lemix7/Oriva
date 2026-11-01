import vine from "@vinejs/vine";

const listTasksSchema = vine.object({
  afterId: vine
    .number()
    .withoutDecimals()
    .min(0)
    .max(2147483647)
    .optional(),
});

export const listTasksValidator =
  vine.compile(listTasksSchema);