/** True when an error means the Anthropic API key was rejected (not a transient/other failure). */
export function isAuthFailure(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const status = (err as { status?: unknown }).status;
  return status === 401 || status === 403;
}

export function authStatus(err: unknown): number | string {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : 'unknown';
}
