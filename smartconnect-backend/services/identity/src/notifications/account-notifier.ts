// Integration boundary for account emails. Production runs with "smtp" (SmtpAccountNotifier: renders the message and
// hands it to the background mailer, ADR 0012) or "disabled", which drops messages and logs that it did so (kind
// only: never the recipient or a token). Development and tests use the in-memory DevMailbox.
import { randomUUID } from 'node:crypto';
import type { Logger, LoggerService } from '@nestjs/common';
import { DevMailbox as KitDevMailbox, type BackgroundMailer } from '@smartconnect/backend-kit';
import { renderAccountEmail } from './account-templates.js';

/**
 * Links point into the web app with the token in the URL FRAGMENT (`#token=…`): browsers never send fragments to
 * servers, so tokens cannot end up in access logs or Referer headers.
 */
export type AccountMessage =
  /** Contains a secret: the raw reset token. Only the recipient may ever see it. */
  | { kind: 'password_reset'; to: string; token: string; link: string; expiresAt: Date }
  /** Contains a secret: proves the recipient controls the address when used. */
  | { kind: 'email_verification'; to: string; token: string; link: string; expiresAt: Date }
  /** Someone tried to register with an address that already has an account (enumeration-safe registration). */
  | { kind: 'registration_attempt'; to: string }
  | { kind: 'password_changed'; to: string };

export interface AccountNotifier {
  send(message: AccountMessage): Promise<void>;
}

export const ACCOUNT_NOTIFIER = Symbol('ACCOUNT_NOTIFIER');

/** Sends after the transaction committed; a delivery failure never changes the HTTP outcome (no oracle). */
export async function notifySafely(notifier: AccountNotifier, logger: Logger, message: AccountMessage): Promise<void> {
  try {
    await notifier.send(message);
  } catch (error) {
    // The error's name only: its message may carry an address or a server reply.
    logger.error({ event: 'account_notification_failed', kind: message.kind, error: errorSummary(error) });
  }
}

/** What is safe to log about a failure: its name and, for delivery errors, the category. Never its message. */
function errorSummary(error: unknown): string {
  const { name, category } = (error ?? {}) as { name?: unknown; category?: unknown };
  return [name, category].filter((part): part is string => typeof part === 'string').join(':') || 'unknown';
}

export class DisabledAccountNotifier implements AccountNotifier {
  constructor(private readonly logger: LoggerService) {}

  send(message: AccountMessage): Promise<void> {
    this.logger.warn({ event: 'account_notification_dropped', kind: message.kind }, 'AccountNotifier');
    return Promise.resolve();
  }
}

/** In-memory mailbox for development and tests (configuration refuses it in production). */
export class DevMailbox extends KitDevMailbox<AccountMessage> implements AccountNotifier {}

/**
 * Renders the message and queues it: `send` returns at once, so no request waits for the mail server (and "forgot
 * password" takes the same time whether or not an account exists). Delivery, retries and their logging are the
 * mailer's. The idempotency key is a random UUID: SMTP has no use for it.
 */
export class SmtpAccountNotifier implements AccountNotifier {
  constructor(
    private readonly mailer: Pick<BackgroundMailer, 'enqueue' | 'close'>,
    private readonly webAppUrl: string,
  ) {}

  send(message: AccountMessage): Promise<void> {
    const { subject, html, text } = renderAccountEmail(message, this.webAppUrl);
    this.mailer.enqueue(message.kind, { to: message.to, subject, html, text, idempotencyKey: randomUUID() });
    return Promise.resolve();
  }

  /** Nest calls this on shutdown (enableShutdownHooks): finish what is queued, then close the connections. */
  async onApplicationShutdown(): Promise<void> {
    await this.mailer.close();
  }
}
