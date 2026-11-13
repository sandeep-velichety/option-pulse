/**
 * Structured, greppable stage logs for council cycles.
 *
 *   [control-plane][stock] snapshot {"cycle":"a1b2c3d4","found":true,"age_min":2,...}
 *
 * Every cycle prints `start`, then one line per stage it reaches, then exactly one terminal
 * line: `done` (a decision was journaled), `skip` (deliberate, with a reason) or `error`
 * (with the stage it died in). Search Render logs for `[control-plane][stock]` and the cycle id.
 */
export type LogScope = 'stock' | 'crypto' | 'boot';

export function clog(
  scope: LogScope,
  cycleId: string,
  stage: string,
  data: Record<string, unknown> = {},
): void {
  console.log(`[control-plane][${scope}] ${stage} ${JSON.stringify({ cycle: cycleId, ...data })}`);
}

export function cerr(
  scope: LogScope,
  cycleId: string,
  stage: string,
  err: unknown,
  data: Record<string, unknown> = {},
): void {
  console.error(
    `[control-plane][${scope}] error ${JSON.stringify({ cycle: cycleId, stage, ...data, ...describeError(err) })}`,
  );
  if (err instanceof Error && err.stack) console.error(err.stack);
}

export function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const out: Record<string, unknown> = { error: err.name, message: err.message.slice(0, 600) };
    const issues = (err as { issues?: unknown }).issues; // ZodError
    if (Array.isArray(issues)) {
      out['issues'] = issues.slice(0, 8).map((i: { path?: unknown[]; message?: string }) => ({
        path: Array.isArray(i.path) ? i.path.join('.') : '',
        message: i.message,
      }));
    }
    const status = (err as { status?: unknown }).status; // Anthropic API errors
    if (status !== undefined) out['http_status'] = status;
    return out;
  }
  return { error: 'non-error thrown', message: String(err).slice(0, 600) };
}

/** Eastern-time wall clock, e.g. "Mon 09:32", for window diagnostics. */
export function easternNow(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
}

/** Plain-language cause + fix for the boot failures we have actually seen on Render. */
export function explainBootError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/client password must be a string/i.test(msg)) {
    return 'No database password reached the process. Put it in DATABASE_URL, or set PGPASSWORD on THIS service (each Render service has its own environment).';
  }
  if (/password authentication failed/i.test(msg)) {
    return 'Database rejected the user/password. The password was probably rotated: update it in Supabase (ALTER ROLE cp_user ...) and in this service\'s DATABASE_URL/PGPASSWORD.';
  }
  if (/tenant or user not found/i.test(msg)) {
    return 'Supabase pooler does not recognise the user. The username must be cp_user.<project-ref> (e.g. cp_user.abcdefghijklmnop), not just cp_user.';
  }
  if (/permission denied/i.test(msg)) {
    return 'The database user lacks a privilege. Check it is a member of cp_role (GRANT cp_role TO cp_user;) and the URL is cp_user, not exec_user/ops_user.';
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(msg)) {
    return 'Cannot reach the database host. Check the host/port in DATABASE_URL (session pooler, port 5432) and that the Supabase project is not paused.';
  }
  if (/ANTHROPIC_API_KEY is required/i.test(msg)) {
    return 'ANTHROPIC_API_KEY is not set on this service. Add it in Render → this service → Environment.';
  }
  if (/DATABASE_URL is required/i.test(msg)) {
    return 'DATABASE_URL is not set on this service. Add it in Render → this service → Environment.';
  }
  if (/credential isolation violated/i.test(msg)) {
    return 'An ALPACA_* variable is set on a control-plane service. Remove it; control-plane must never hold broker keys.';
  }
  return 'Unrecognised boot error — see the error and stack above.';
}
