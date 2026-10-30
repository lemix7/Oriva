import vine from "@vinejs/vine";

const workspaceParamsSchema = vine.object({
  wid: vine
    .number()
    .withoutDecimals()
    .min(1)
    .max(2147483647),
});

export const workspaceParamsValidator =
  vine.compile(workspaceParamsSchema);