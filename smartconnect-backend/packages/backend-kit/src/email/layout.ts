// SmartConnect's transactional email layout (ADR 0012): one responsive, table-based HTML template with inline CSS, and
// a plain-text twin. Every text value is escaped; the only link is `action.url`, which must be http(s) and appears
// escaped in the button and in the copy-this-link fallback. No remote images, no tracking pixels, no postal address.
import { escapeHtml } from './html.js';

// Neutral brand colours, copied from the web app's light theme (smartconnect-frontend/packages/design-tokens).
const COLOR = {
  page: '#f5f6f8',
  card: '#ffffff',
  border: '#e0e3e8',
  text: '#11151c',
  muted: '#555e6d',
  primary: '#2356d4',
  primaryText: '#ffffff',
} as const;
const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export interface EmailContent {
  subject: string;
  /** The grey preview line most mail apps show after the subject. */
  preheader: string;
  heading: string;
  paragraphs: string[];
  /** The one call to action: a button, plus the raw link as a fallback. */
  action?: { label: string; url: string };
  /** Small print under the button. */
  note?: string;
  /** Which reason the footer gives for the email. */
  footer?: 'account' | 'invitation';
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const FOOTERS = {
  account: 'You are receiving this email because of activity on your SmartConnect account.',
  invitation: 'You are receiving this email because someone invited you to join an organization on SmartConnect.',
} as const;

const UTC_FORMAT = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'UTC',
  hourCycle: 'h23',
});

/** An unambiguous moment for email text: `3 November 2026 at 15:48 UTC`. */
export const formatUtcDateTime = (date: Date): string => `${UTC_FORMAT.format(date)} UTC`;

export function renderEmail(content: EmailContent): RenderedEmail {
  const { subject, preheader, heading, paragraphs, action, note, footer = 'account' } = content;
  if (action) assertHttpUrl(action.url);
  const e = escapeHtml;
  const footerText = FOOTERS[footer];

  const paragraphHtml = paragraphs
    .map((p) => `<p style="margin:0 0 16px;font:16px/1.5 ${FONT};color:${COLOR.text};">${e(p)}</p>`)
    .join('');
  const actionHtml = action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr>` +
      `<td align="center" bgcolor="${COLOR.primary}" style="border-radius:8px;background:${COLOR.primary};">` +
      `<a href="${e(action.url)}" style="display:inline-block;padding:12px 24px;font:600 16px/1.25 ${FONT};color:${COLOR.primaryText};text-decoration:none;border-radius:8px;">${e(action.label)}</a>` +
      `</td></tr></table>` +
      `<p style="margin:0 0 16px;font:14px/1.5 ${FONT};color:${COLOR.muted};">If the button does not work, copy this link: ` +
      `<span style="word-break:break-all;color:${COLOR.primary};">${e(action.url)}</span></p>`
    : '';
  const noteHtml = note ? `<p style="margin:0 0 16px;font:14px/1.5 ${FONT};color:${COLOR.muted};">${e(note)}</p>` : '';

  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="light"><title>${e(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:${COLOR.page};">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${e(preheader)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLOR.page};">` +
    `<tr><td align="center" style="padding:24px 16px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">` +
    `<tr><td style="padding:0 0 16px;font:700 22px/1.2 ${FONT};color:${COLOR.primary};">SmartConnect</td></tr>` +
    `<tr><td style="background:${COLOR.card};border:1px solid ${COLOR.border};border-radius:12px;padding:32px 28px;">` +
    `<h1 style="margin:0 0 16px;font:700 22px/1.3 ${FONT};color:${COLOR.text};">${e(heading)}</h1>` +
    `${paragraphHtml}${actionHtml}${noteHtml}` +
    `</td></tr>` +
    `<tr><td style="padding:16px 8px 0;font:12px/1.5 ${FONT};color:${COLOR.muted};">${e(footerText)}</td></tr>` +
    `</table></td></tr></table></body></html>`;

  const text = [
    heading,
    ...paragraphs,
    ...(action ? [`${action.label}:\n${action.url}`] : []),
    ...(note ? [note] : []),
    '--',
    'SmartConnect',
    footerText,
  ].join('\n\n');
  return { subject, html, text };
}

function assertHttpUrl(value: string): void {
  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    throw new Error('email action URL must be an absolute http(s) URL');
  }
  if (protocol !== 'http:' && protocol !== 'https:')
    throw new Error('email action URL must be an absolute http(s) URL');
}
