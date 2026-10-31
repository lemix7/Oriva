import vine from "@vinejs/vine";

const workspaceOwnershipTransferSchema = vine.object({
  newOwnerId: vine
    .number()
    .withoutDecimals()
    .min(1)
    .max(2147483647),
});

export const workspaceOwnershipTransferValidator =
  vine.compile(workspaceOwnershipTransferSchema);