import vine from "@vinejs/vine";

const workspaceMemberRoleSchema = vine.object({
  role: vine.enum(["editor", "viewer"]),
});

export const workspaceMemberRoleValidator =
  vine.compile(workspaceMemberRoleSchema);