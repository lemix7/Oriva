import vine from "@vinejs/vine";

const workspaceProjectParamsSchema = vine.object({
  wid: vine.number().withoutDecimals().min(1).max(2147483647),
  pid: vine.number().withoutDecimals().min(1).max(2147483647),
});

export const workspaceProjectParamsValidator =
  vine.compile(workspaceProjectParamsSchema);