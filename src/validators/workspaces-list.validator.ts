import vine from "@vinejs/vine";

const listWorkspacesSchema = vine.object({
  afterId: vine.number().withoutDecimals().min(0).optional(),
});

export const listWorkspacesValidator =
  vine.compile(listWorkspacesSchema);
