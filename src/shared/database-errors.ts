function isUniqueConstraintError(
  error: unknown,
  constraintName: string,
): boolean {
  const cause =
    typeof error === "object" && error !== null && "cause" in error
      ? error.cause
      : error;

  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "23505" &&
    "constraint" in cause &&
    cause.constraint === constraintName
  );
}

export function isDuplicateEmailError(error: unknown): boolean {
  return isUniqueConstraintError(error, "users_email_unique");
}

export function isDuplicateProjectStatusNameError(error: unknown): boolean {
  return isUniqueConstraintError(error, "project_statuses_project_name_unique");
}
