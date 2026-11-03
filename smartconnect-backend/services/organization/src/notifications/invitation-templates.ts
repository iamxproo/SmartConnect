// The text of the invitation email (ADR 0012), on the kit's branded layout. The organization name, the role name and
// the inviter's name are typed by people: they are cleaned of control and direction-override characters (no header
// injection, no spoofed lines), length-capped, escaped by renderEmail, and never turned into links. The only link is
// the one the service built from WEB_APP_URL, with the token in the URL fragment.
import { formatUtcDateTime, renderEmail, type RenderedEmail } from '@smartconnect/backend-kit';
import type { InvitationMessage } from './invitation-notifier.js';

const MAX_NAME = 80;
const MAX_SUBJECT = 200;
// Control characters, line separators and direction overrides.
// eslint-disable-next-line no-control-regex -- control characters are what this removes
const UNSAFE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u2028-\\u202e\\u2066-\\u2069]+', 'g');

/** One line, no control characters, at most MAX_NAME characters. */
export function cleanName(value: string): string {
  const clean = value.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > MAX_NAME ? `${clean.slice(0, MAX_NAME - 1).trimEnd()}…` : clean;
}

export function invitationEmail(message: InvitationMessage): RenderedEmail {
  const organization = cleanName(message.organizationName) || 'an organization';
  const role = cleanName(message.roleName) || 'a member';
  const inviter = (message.invitedBy && cleanName(message.invitedBy)) || 'Someone';
  const subject = `${inviter} invited you to ${organization} on SmartConnect`.slice(0, MAX_SUBJECT);
  return renderEmail({
    subject,
    preheader: `Join ${organization} on SmartConnect.`,
    heading: `You are invited to ${organization}`,
    paragraphs: [
      `${inviter} invited you to join ${organization} on SmartConnect.`,
      `Organization: ${organization}`,
      `Role: ${role}`,
      `Invited by: ${inviter}`,
      `This invitation works once and expires on ${formatUtcDateTime(message.expiresAt)}.`,
    ],
    action: { label: 'Accept invitation', url: message.link },
    note: 'This invitation works only for the address it was sent to, and only after you sign in to SmartConnect with it. If you were not expecting it, you can ignore this email.',
    footer: 'invitation',
  });
}
