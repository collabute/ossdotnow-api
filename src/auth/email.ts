import { Resend } from 'resend';

import { env } from '../env/server.js';

type AuthEmailType =
  | 'verification'
  | 'password-reset'
  | 'existing-signup'
  | 'project-approved'
  | 'project-rejected';

interface SendAuthEmailInput {
  to: string;
  type: AuthEmailType;
  subject: string;
  actionText?: string;
  actionUrl?: string;
  body: string;
}

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function buildTextEmail(input: SendAuthEmailInput) {
  const lines = ['oss.now', '', input.body];

  if (input.actionUrl) {
    lines.push('', `${input.actionText ?? 'Open link'}: ${input.actionUrl}`);
  }

  lines.push('', 'If you did not request this, you can ignore this email.');

  return lines.join('\n');
}

function buildHtmlEmail(input: SendAuthEmailInput) {
  const actionMarkup = input.actionUrl
    ? `<p style="margin:24px 0 0"><a href="${escapeHtml(input.actionUrl)}" style="display:inline-block;background:#ffffff;color:#09090b;text-decoration:none;padding:10px 14px;border:1px solid #ffffff;font-size:14px;font-weight:600">${escapeHtml(
        input.actionText ?? 'Open link',
      )}</a></p><p style="margin:16px 0 0;color:#a1a1aa;font-size:13px;line-height:20px">If the button does not work, paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(
        input.actionUrl,
      )}</span></p>`
    : '';

  return `<!doctype html>
<html>
  <body style="margin:0;background:#09090b;color:#ffffff;font-family:Inter,Arial,sans-serif">
    <div style="max-width:560px;margin:0 auto;padding:40px 24px">
      <p style="margin:0 0 28px;color:#ffffff;font-size:20px;font-weight:700">oss.now</p>
      <h1 style="margin:0 0 16px;color:#ffffff;font-size:24px;line-height:32px">${escapeHtml(input.subject)}</h1>
      <p style="margin:0;color:#d4d4d8;font-size:15px;line-height:24px">${escapeHtml(input.body)}</p>
      ${actionMarkup}
      <p style="margin:28px 0 0;color:#71717a;font-size:12px;line-height:18px">If you did not request this, you can ignore this email.</p>
    </div>
  </body>
</html>`;
}

export async function sendAuthEmail(input: SendAuthEmailInput) {
  if (!resend || !env.AUTH_EMAIL_FROM) {
    if (env.NODE_ENV === 'production') {
      throw new Error('Resend auth email delivery is not configured');
    }

    console.info(
      `[auth-email:${input.type}] ${input.subject} for ${input.to}${
        input.actionUrl ? ` -> ${input.actionUrl}` : ''
      }`,
    );
    return;
  }

  const response = await resend.emails.send({
    from: env.AUTH_EMAIL_FROM,
    to: input.to,
    subject: input.subject,
    html: buildHtmlEmail(input),
    text: buildTextEmail(input),
    replyTo: env.AUTH_EMAIL_REPLY_TO || undefined,
  });

  if (response.error) {
    throw new Error(`Failed to send auth email: ${response.error.message}`);
  }
}
