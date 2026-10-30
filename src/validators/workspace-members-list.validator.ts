import vine from "@vinejs/vine";

const workspaceMembersListSchema = vine.object({
  afterUserId: vine
    .number()
    .withoutDecimals()
    .min(0)
    .max(2147483647)
    .optional(),
});

export const workspaceMembersListValidator =
  vine.compile(workspaceMembersListSchema);