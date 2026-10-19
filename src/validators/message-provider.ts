import vine, { SimpleMessagesProvider } from "@vinejs/vine";

const fields = {
  name: "Name",
  email: "Email",
  password: "Password",
  title: "Title",
  status: "Status",
};

const messageProvider = vine.messagesProvider = new SimpleMessagesProvider(
  {
    required: "The {{field}} field is required",
    string: "The value of {{field}} field must be a string",
    email: "The value is not a valid email address",

    "name.required": "Please enter a name",
    "name.minLength": "Please enter a name",
    "email.required": "Please enter an email",
    "password.required": "Please enter a password",
    "password.minLength": "Password must be min 8 char"
  },
  fields,
);


export default messageProvider