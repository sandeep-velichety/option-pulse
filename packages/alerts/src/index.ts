/**
 * Lightweight alert module using Resend (https://resend.com).
 * Never throws — a broken alert must not crash the caller.
 * All env vars are optional; when absent, alerts log to console only.
 */

const RESEND_API_KEY = process.env['RESEND_API_KEY'];
const ALERT_TO_EMAIL = process.env['ALERT_TO_EMAIL'] ?? 'anusaninfotech@gmail.com';
const ALERT_FROM_EMAIL = process.env['ALERT_FROM_EMAIL'] ?? 'Trading Council <alerts@tradingcouncil.dev>';

export async function sendAlert(
  subject: string,
  body: string,
  html?: string,
): Promise<void> {
  if (!RESEND_API_KEY) {
    console.warn(`[alerts] RESEND_API_KEY not set — logging alert to console:\n[${subject}] ${body}`);
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
