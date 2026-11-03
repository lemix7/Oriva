import vine from "@vinejs/vine";

const id = () =>
  vine.number().withoutDecimals().min(1).max(2147483647);

export const workspaceProjectStatusParamsValidator = vine.compile(
  vine.object({
    wid: id(),
    pid: id(),
    sid: id(),
  }),
);