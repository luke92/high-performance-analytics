/** Thrown by the core for any invalid input or configuration. */
export class ValidationError extends Error {
  override readonly name = "ValidationError";
}
