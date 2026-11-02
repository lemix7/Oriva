export function isDuplicateEmailError(error: unknown): boolean {
  const cause =
    typeof error === "object" &&
    error !== null &&
    "cause" in error
      ? error.cause
      : error;

  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "23505" &&
    "constraint" in cause &&
    cause.constraint === "users_email_unique"
  );
}
