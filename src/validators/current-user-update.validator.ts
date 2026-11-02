import vine from "@vinejs/vine";

export const updateCurrentUserValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(5).maxLength(30).optional(),
    email: vine.string().trim().toLowerCase().email().maxLength(30).optional(),
  }),
);
