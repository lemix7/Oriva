import vine from "@vinejs/vine";

const createInvitationSchema = vine.object({
  email: vine.string().trim().email().maxLength(254),
  role: vine.enum(["editor", "viewer"]),
});

export const createInvitationValidator =
  vine.compile(createInvitationSchema);