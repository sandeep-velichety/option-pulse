import { sendAlertOnce } from '@trading-council/alerts';

/** True when Alpaca rejected our credentials (SDK: AuthError = 401, PermissionError = 403). */
export function isAlpacaAuthError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; status?: unknown };
  return e.name === 'AuthError' || e.name === 'PermissionError' || e.status === 401 || e.status === 403;
}

/**
 * If `err` is an Alpaca auth rejection, alert immediately — at most once per 6h per process, since
 * the same failure repeats every few minutes (snapshots) or seconds (claim loop). Safe to call from
 * any catch block: it never throws and does nothing for other errors. Returns whether it was one.
 */
export function reportIfAlpacaAuth(where: string, err: unknown): boolean {
  if (!isAlpacaAuthError(err)) return false;
  const status = (err as { status?: unknown }).status ?? 'auth error';
  console.error(`[execution] ALPACA KEY REJECTED (${String(status)}) in ${where} — no snapshots or orders will work.`);
  void sendAlertOnce(
    'alpaca-auth',
    'Execution DOWN: Alpaca API key rejected',
    `The execution service could not authenticate with Alpaca (${String(status)}) while running ${where}.\n` +
      `Market snapshots and order placement are failing, so the council has no fresh data and no trades can execute.\n\n` +
      `Fix: regenerate the PAPER keys at alpaca.markets and set ALPACA_KEY and ALPACA_SECRET on the ` +
      `execution service in Render, then redeploy it.`,
  ).catch(() => {});
  return true;
}
