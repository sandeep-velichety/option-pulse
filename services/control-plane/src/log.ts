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
