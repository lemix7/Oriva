import vine from "@vinejs/vine";

const listInvitationsSchema = vine.object({
  afterId: vine
    .number()
    .withoutDecimals()
    .min(0)
    .max(2147483647)
    .optional(),
});

export const listInvitationsValidator =
  vine.compile(listInvitationsSchema);