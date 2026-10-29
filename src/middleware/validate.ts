import { type Request, type Response, type NextFunction } from "express";
import type { VineValidator } from "@vinejs/vine";
import type { MessagesProviderContact } from "@vinejs/vine/types";

type ValidationSource = "body" | "query";

const validate = (
  validator: VineValidator<any, any>,
  messageProvider: MessagesProviderContact,
  source: ValidationSource = "body",
) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const output = await validator.validate(req[source], {
      messagesProvider: messageProvider,
    });

    res.locals.validatedData = output;
    next();
  };
};

export default validate;
