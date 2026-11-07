import vine from "@vinejs/vine";

export const changePasswordValidator = vine.compile(
  vine.object({
    currentPassword: vine.string().minLength(8),
    newPassword: vine.string().minLength(8).maxLength(72),
  }),
);