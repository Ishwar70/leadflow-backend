import { env } from "../config/env";

export function emailEnabled() {
  return Boolean(env().RESEND_API_KEY);
}

/** Sends a transactional email through Resend. Returns false when email is not configured. */
export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const { RESEND_API_KEY, EMAIL_FROM } = env();
  if (!RESEND_API_KEY) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, html }),
      signal: controller.signal,
    });
    if (!res.ok) console.error(`[email] Resend responded ${res.status}`);
    return res.ok;
  } catch (err) {
    console.error("[email] send failed", (err as Error).message);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export function emailLayout(title: string, body: string, ctaLabel?: string, ctaUrl?: string) {
  return `<!doctype html><html><body style="margin:0;background:#f6f7fb;font-family:Inter,Segoe UI,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
  <table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;border:1px solid #e5e7eb">
  <tr><td style="padding:24px 28px;border-bottom:1px solid #eef0f4"><strong style="color:#4f46e5;font-size:18px">LeadFlow CRM</strong></td></tr>
  <tr><td style="padding:28px"><h2 style="margin:0 0 12px;color:#0f172a;font-size:20px">${title}</h2>
  <p style="color:#475569;line-height:1.6;font-size:14px">${body}</p>
  ${ctaUrl ? `<a href="${ctaUrl}" style="display:inline-block;margin-top:16px;background:#4f46e5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;font-size:14px">${ctaLabel}</a>` : ""}
  </td></tr></table></td></tr></table></body></html>`;
}
