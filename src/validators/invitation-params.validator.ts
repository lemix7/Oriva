import vine from "@vinejs/vine";

const invitationParamsSchema = vine.object({
  wid: vine.number().withoutDecimals().min(1).max(2147483647),
  iid: vine.number().withoutDecimals().min(1).max(2147483647),
});

export const invitationParamsValidator =
  vine.compile(invitationParamsSchema);