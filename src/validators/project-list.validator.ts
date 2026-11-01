import vine from "@vinejs/vine";

const listProjectsSchema = vine.object({
  afterId: vine
    .number()
    .withoutDecimals()
    .min(0)
    .max(2147483647)
    .optional(),
});

export const listProjectsValidator =
  vine.compile(listProjectsSchema);