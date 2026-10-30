import vine from "@vinejs/vine";

const workspaceMemberParamsSchema = vine.object({
  wid: vine.number().withoutDecimals().min(1).max(2147483647),
  uid: vine.number().withoutDecimals().min(1).max(2147483647),
});

export const workspaceMemberParamsValidator =
  vine.compile(workspaceMemberParamsSchema);