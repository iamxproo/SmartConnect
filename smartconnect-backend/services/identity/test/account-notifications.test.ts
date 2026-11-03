import { Logger } from '@nestjs/common';
import { BackgroundMailer, EmailDeliveryError, type EmailMessage } from '@smartconnect/backend-kit';
import { describe, expect, it, vi } from 'vitest';
import { notifySafely, SmtpAccountNotifier, type AccountMessage } from '../src/notifications/account-notifier.js';
import {
  emailVerificationEmail,
  passwordChangedEmail,
  passwordResetEmail,
  registrationAttemptEmail,
  renderAccountEmail,
} from '../src/notifications/account-templates.js';

const WEB = 'https://app.example.com';
const TOKEN = 'Zq3x-raw-one-time-token_abcdefghijklmnopqrstu';
const expiresAt = new Date('2026-11-05T08:30:00Z');
const verification = {
  kind: 'email_verification',
  to: 'ada@example.com',
  token: TOKEN,
  link: `${WEB}/verify-email#token=${TOKEN}`,
  expiresAt,
} as const;
const reset = {
  kind: 'password_reset',
  to: 'ada@example.com',
  token: TOKEN,
  link: `${WEB}/reset-password#token=${TOKEN}`,
  expiresAt,
} as const;

describe('account email templates', () => {
  it('verification: subject, button to the fragment link, expiry in UTC', () => {
    const { subject, html, text } = emailVerificationEmail(verification);
    expect(subject).toBe('Verify your SmartConnect email address');
    expect(html).toContain(`<a href="${verification.link}"`);
    expect(html).toContain('>Verify email address</a>');
    expect(html).toContain('5 November 2026 at 08:30 UTC');
    expect(text.split('\n')).toContain(verification.link);
    expect(text).toContain('5 November 2026 at 08:30 UTC');
  });

  it('reset: subject, link, expiry and the ignore-me line', () => {
    const { subject, html, text } = passwordResetEmail(reset);
    expect(subject).toBe('Reset your SmartConnect password');
    expect(html).toContain(`<a href="${reset.link}"`);
    expect(html).toContain('5 November 2026 at 08:30 UTC');
    expect(text).toContain("If you didn't ask for this, ignore this email");
    expect(html).toContain('If you didn&#39;t ask for this, ignore this email');
  });

  it('password changed: says so and links to the forgot-password page', () => {
    const { subject, html, text } = passwordChangedEmail(WEB);
    expect(subject).toBe('Your SmartConnect password was changed');
    expect(html).toContain(`<a href="${WEB}/forgot-password"`);
    expect(text).toContain("If it wasn't you, reset your password now");
    expect(html).not.toContain('token=');
  });

  it('registration attempt: sign-in and reset links, no token', () => {
    const { subject, html, text } = registrationAttemptEmail(WEB);
    expect(subject).toBe('Someone tried to create a SmartConnect account with your email');
    expect(html).toContain(`<a href="${WEB}/login"`);
    expect(html).toContain(`${WEB}/forgot-password`);
    expect(text).toContain(`${WEB}/forgot-password`);
    expect(html + text).not.toContain('token');
  });

  it('renders every kind, with the account footer', () => {
    const messages: AccountMessage[] = [
      verification,
      reset,
      { kind: 'registration_attempt', to: 'a@example.com' },
      { kind: 'password_changed', to: 'a@example.com' },
    ];
    for (const message of messages) {
      const email = renderAccountEmail(message, WEB);
      expect(email.html).toContain('because of activity on your SmartConnect account');
      expect(email.subject).not.toMatch(/[\r\n]/);
    }
  });
});

describe('SmtpAccountNotifier', () => {
  it('resolves at once even when the transport hangs, and queues the rendered email', async () => {
    const sent: EmailMessage[] = [];
    const transport = {
      send: (message: EmailMessage) => {
        sent.push(message);
        return new Promise<{ id: null }>(() => undefined);
      },
    };
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const notifier = new SmtpAccountNotifier(new BackgroundMailer(transport, logger), WEB);
    const started = Date.now();
    await notifier.send(verification);
    expect(Date.now() - started).toBeLessThan(100);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'ada@example.com', subject: 'Verify your SmartConnect email address' });
    expect(sent[0]!.html).toContain(`href="${WEB}/verify-email#token=${TOKEN}"`);
    expect(sent[0]!.text).toContain(`${WEB}/verify-email#token=${TOKEN}`);
    expect(sent[0]!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('enqueues with the message kind and never logs the recipient or token itself', async () => {
    const enqueue = vi.fn<(kind: string, message: EmailMessage) => void>();
    const notifier = new SmtpAccountNotifier({ enqueue, close: vi.fn() }, WEB);
    await notifier.send(reset);
    await notifier.send({ kind: 'password_changed', to: 'ada@example.com' });
    expect(enqueue.mock.calls.map(([kind]) => kind)).toEqual(['password_reset', 'password_changed']);
  });

  it('closes (drains) the mailer on shutdown', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    await new SmtpAccountNotifier({ enqueue: vi.fn(), close }, WEB).onApplicationShutdown();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('notifySafely', () => {
  it('logs the error name and category, never its message', async () => {
    const logger = new Logger('test');
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const notifier = {
      send: () => Promise.reject(new Error('550 ada@example.com refused token Zq3x-raw')),
    };
    await notifySafely(notifier, logger, reset);
    await notifySafely({ send: () => Promise.reject(new EmailDeliveryError('network', true)) }, logger, reset);
    expect(error.mock.calls).toEqual([
      [{ event: 'account_notification_failed', kind: 'password_reset', error: 'Error' }],
      [{ event: 'account_notification_failed', kind: 'password_reset', error: 'EmailDeliveryError:network' }],
    ]);
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/ada@|Zq3x/);
  });
});
