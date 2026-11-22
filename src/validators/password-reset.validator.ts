import vine from "@vinejs/vine";

export const forgotPasswordValidator = vine.compile(
  vine.object({
    email: vine.string().trim().toLowerCase().email().maxLength(30),
  }),
);

export const resetPasswordValidator = vine.compile(
  vine.object({
    token: vine.string().regex(/^[A-Za-z0-9_-]{43}$/),
    newPassword: vine.string().minLength(8).maxLength(72),
  }),
);