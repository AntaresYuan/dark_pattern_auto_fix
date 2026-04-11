/** Safely extract a string message from an unknown caught value. */
export function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
