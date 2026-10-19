import vine, { errors } from "@vinejs/vine";

const createTaskSchema = vine.object({
  title: vine.string().minLength(3),
  description: vine.string().optional(),
  status: vine.enum(["done", "cancelled", "on progress"]),
});

const createTaskValidator = vine.compile(createTaskSchema);

export default createTaskValidator
