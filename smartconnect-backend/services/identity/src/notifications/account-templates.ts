// The text of account emails (ADR 0012), one function per message kind, on the kit's branded layout. Links come from
// the message (built by the services from WEB_APP_URL, token in the URL fragment) or from `webAppUrl` for the
// token-free pages. Nothing here is user-controlled, so nothing needs escaping beyond what renderEmail does.
import { formatUtcDateTime, renderEmail, type RenderedEmail } from '@smartconnect/backend-kit';
import type { AccountMessage } from './account-notifier.js';

type Of<K extends AccountMessage['kind']> = Extract<AccountMessage, { kind: K }>;

export function emailVerificationEmail(message: Of<'email_verification'>): RenderedEmail {
  return renderEmail({
    subject: 'Verify your SmartConnect email address',
    preheader: 'Confirm this address to finish setting up your account.',
    heading: 'Verify your email address',
    paragraphs: [
      'Welcome to SmartConnect. Confirm that this is your email address to finish setting up your account.',
      `This link works once and expires on ${formatUtcDateTime(message.expiresAt)}.`,
    ],
    action: { label: 'Verify email address', url: message.link },
    note: 'If you did not create a SmartConnect account, you can ignore this email.',
  });
}

export function passwordResetEmail(message: Of<'password_reset'>): RenderedEmail {
  return renderEmail({
    subject: 'Reset your SmartConnect password',
    preheader: 'Use this link to choose a new password.',
    heading: 'Reset your password',
    paragraphs: [
      'We received a request to reset the password of your SmartConnect account.',
      `This link works once and expires on ${formatUtcDateTime(message.expiresAt)}.`,
    ],
    action: { label: 'Choose a new password', url: message.link },
    note: "If you didn't ask for this, ignore this email. Your password will not change.",
  });
}

export function passwordChangedEmail(webAppUrl: string): RenderedEmail {
  return renderEmail({
    subject: 'Your SmartConnect password was changed',
    preheader: 'If this was not you, reset your password now.',
    heading: 'Your password was changed',
    paragraphs: [
      'The password of your SmartConnect account was just changed.',
      "If you made this change, you don't need to do anything. If it wasn't you, reset your password now.",
    ],
    action: { label: 'Reset your password', url: `${webAppUrl}/forgot-password` },
  });
}

export function registrationAttemptEmail(webAppUrl: string): RenderedEmail {
  return renderEmail({
    subject: 'Someone tried to create a SmartConnect account with your email',
    preheader: 'You already have an account. Nothing has changed.',
    heading: 'You already have a SmartConnect account',
    paragraphs: [
      'Someone just tried to create a SmartConnect account with this email address, which already has one. Nothing has changed.',
      `If it was you, sign in instead. If you forgot your password, you can reset it at ${webAppUrl}/forgot-password`,
    ],
    action: { label: 'Sign in', url: `${webAppUrl}/login` },
    note: 'If it was not you, you can ignore this email.',
  });
}

export function renderAccountEmail(message: AccountMessage, webAppUrl: string): RenderedEmail {
  switch (message.kind) {
    case 'email_verification':
      return emailVerificationEmail(message);
    case 'password_reset':
      return passwordResetEmail(message);
    case 'password_changed':
      return passwordChangedEmail(webAppUrl);
    case 'registration_attempt':
      return registrationAttemptEmail(webAppUrl);
  }
}
