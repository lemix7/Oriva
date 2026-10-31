import vine from "@vinejs/vine";

const acceptInvitationSchema = vine.object({
  token: vine
    .string()
    .fixedLength(64)
    .regex(/^[a-f0-9]{64}$/),
});

export const acceptInvitationValidator =
  vine.compile(acceptInvitationSchema);