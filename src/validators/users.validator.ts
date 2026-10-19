import vine, { errors } from "@vinejs/vine";

const createUserSchema = vine.object({
  name: vine.string().trim().minLength(5),
  email: vine.string().email(),
  password: vine.string().minLength(8),
});

const loginUserSchema = vine.object({
  email: vine.string().email(),
  password: vine.string().minLength(8),
});

const createUserValidator = vine.compile(createUserSchema);
const loginUserValidator = vine.compile(loginUserSchema)

export { createUserSchema, loginUserSchema, createUserValidator , loginUserValidator };
