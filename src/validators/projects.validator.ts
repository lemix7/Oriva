import vine, { errors } from "@vinejs/vine";

//enum status {
  //   ACTIVE = 'active',
  //   INACTIVE = 'inactive',
  //   PENDING = 'pending',
  //   COMPLETED = 'completed'
  // }

const CreateProjectSchema = vine.object({
  name: vine.string().minLength(3),
  description: vine.string().optional(),
  status: vine.enum(['active' , 'inactive' , 'pending' , 'completed']),
});

const createProjectValidator = vine.compile(CreateProjectSchema)

export default createProjectValidator