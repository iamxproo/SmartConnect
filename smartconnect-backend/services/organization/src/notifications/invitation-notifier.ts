// Integration boundary for invitation emails. Production runs with "smtp" (SmtpInvitationNotifier: renders the message
// and hands it to the background mailer, ADR 0012) or "disabled" (messages dropped, only their kind logged);
// development and tests use the in-memory DevMailbox, shown at GET /dev/mailbox on this service (never routed by the
// gateway). Tokens are never logged.
import { randomUUID } from 'node:crypto';
import type { Logger, LoggerService } from '@nestjs/common';
import { DevMailbox, type BackgroundMailer } from '@smartconnect/backend-kit';
import { invitationEmail } from './invitation-templates.js';

export interface InvitationMessage {
  kind: 'organization_invitation';
  to: string;
  /** Secret. The link carries it in the URL fragment, so it never reaches server logs. */
  token: string;
  link: string;
  organizationName: string;
  roleName: string;
  invitedBy: string | null;
  expiresAt: Date;
}

export interface InvitationNotifier {
  send(message: InvitationMessage): Promise<void>;
}

export const INVITATION_NOTIFIER = Symbol('INVITATION_NOTIFIER');

export class DisabledInvitationNotifier implements InvitationNotifier {
  constructor(private readonly logger: LoggerService) {}

  send(message: InvitationMessage): Promise<void> {
    this.logger.warn({ event: 'invitation_notification_dropped', kind: message.kind }, 'InvitationNotifier');
    return Promise.resolve();
  }
}

export class InvitationDevMailbox extends DevMailbox<InvitationMessage> implements InvitationNotifier {}

/** Delivery happens after the transaction committed; a failure is logged (kind only) and never changes the outcome. */
export async function notifySafely(notifier: InvitationNotifier, logger: Logger, message: InvitationMessage) {
  try {
    await notifier.send(message);
  } catch (error) {
    // The error's name only: its message may carry an address or a server reply.
    logger.error({ event: 'invitation_notification_failed', kind: message.kind, error: errorSummary(error) });
  }
}

/** What is safe to log about a failure: its name and, for delivery errors, the category. Never its message. */
function errorSummary(error: unknown): string {
  const { name, category } = (error ?? {}) as { name?: unknown; category?: unknown };
  return [name, category].filter((part): part is string => typeof part === 'string').join(':') || 'unknown';
}

/**
 * Renders the invitation and queues it: `send` returns at once, so no request waits for the mail server. Delivery,
 * retries and their logging are the mailer's. The idempotency key is a random UUID: SMTP has no use for it.
 */
export class SmtpInvitationNotifier implements InvitationNotifier {
  constructor(private readonly mailer: Pick<BackgroundMailer, 'enqueue' | 'close'>) {}

  send(message: InvitationMessage): Promise<void> {
    const { subject, html, text } = invitationEmail(message);
    this.mailer.enqueue(message.kind, { to: message.to, subject, html, text, idempotencyKey: randomUUID() });
    return Promise.resolve();
  }

  /** Nest calls this on shutdown (enableShutdownHooks): finish what is queued, then close the connections. */
  async onApplicationShutdown(): Promise<void> {
    await this.mailer.close();
  }
}
