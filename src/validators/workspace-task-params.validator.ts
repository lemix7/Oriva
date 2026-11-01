import vine from "@vinejs/vine";

const workspaceTaskParamsSchema = vine.object({
  wid: vine.number().withoutDecimals().min(1).max(2147483647),
  pid: vine.number().withoutDecimals().min(1).max(2147483647),
  tid: vine.number().withoutDecimals().min(1).max(2147483647),
});

export const workspaceTaskParamsValidator = vine.compile(
  workspaceTaskParamsSchema,
);
