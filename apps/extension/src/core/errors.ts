/** The message of a caught error, or the thrown value itself when it is not an `Error`. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
