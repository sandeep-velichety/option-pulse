/**
 * Lightweight alert module using Resend (https://resend.com).
 * Never throws — a broken alert must not crash the caller.
 * All env vars are optional; when none is configured, alerts log to console only.
 *
 * Channels (each independent; any that is configured is used):
 *   email   — RESEND_API_KEY (+ ALERT_TO_EMAIL, ALERT_FROM_EMAIL)
 *   webhook — ALERT_WEBHOOK_URL: a Slack incoming-webhook or Discord webhook URL. The JSON body
 *             carries both `text` (Slack) and `content` (Discord).
 */

const RESEND_API_KEY = process.env['RESEND_API_KEY'];
const ALERT_TO_EMAIL = process.env['ALERT_TO_EMAIL'] ?? 'anusaninfotech@gmail.com';
const ALERT_FROM_EMAIL = process.env['ALERT_FROM_EMAIL'] ?? 'Trading Council <alerts@tradingcouncil.dev>';
const ALERT_WEBHOOK_URL = process.env['ALERT_WEBHOOK_URL'];

async function sendWebhook(subject: string, body: string): Promise<void> {
  if (!ALERT_WEBHOOK_URL) return;
  try {
    const msg = `${subject}\n${body}`.slice(0, 1900); // Discord caps content at 2000 chars
    const res = await fetch(ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: msg, content: msg }),
    });
    if (!res.ok) console.error(`[alerts] webhook error ${res.status}`);
    else console.log(`[alerts] webhook sent: ${subject}`);
  } catch (err) {
    console.error('[alerts] webhook failed (non-fatal)', err);
  }
}

export async function sendAlert(
  subject: string,
  body: string,
  html?: string,
): Promise<void> {
  await sendWebhook(subject, body);
  if (!RESEND_API_KEY) {
    console.warn(
      `[alerts] ${ALERT_WEBHOOK_URL ? 'email not configured' : 'RESEND_API_KEY and ALERT_WEBHOOK_URL not set'} — ` +
        `alert logged:\n[${subject}] ${body}`,
    );
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: ALERT_FROM_EMAIL,
        to: [ALERT_TO_EMAIL],
        subject,
        text: body,
        ...(html ? { html } : {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[alerts] Resend error ${res.status}: ${text}`);
    } else {
      console.log(`[alerts] sent: ${subject}`);
    }
  } catch (err) {
    console.error('[alerts] sendAlert failed (non-fatal)', err);
  }
}

export function fmtUsd(n: number): string {
  return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
}

const lastSent = new Map<string, number>();

/**
 * Send an alert at most once per `cooldownMs` per `key`, in this process's memory. For long-running
 * workers (execution) where the same failure repeats every few seconds/minutes. Returns whether it sent.
 */
export async function sendAlertOnce(
  key: string,
  subject: string,
  body: string,
  cooldownMs = 6 * 60 * 60 * 1000,
): Promise<boolean> {
  const now = Date.now();
  const prev = lastSent.get(key);
  if (prev !== undefined && now - prev < cooldownMs) return false;
  lastSent.set(key, now);
  await sendAlert(subject, body);
  return true;
}
