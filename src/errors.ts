/** Message text for an unknown thrown value, for logs and error reports. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
