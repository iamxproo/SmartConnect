// Integration boundary for invitation emails. Production runs with "smtp" (SmtpInvitationNotifier: renders the message
// and hands it to the background mailer, ADR 0012) or "disabled" (messages dropped, only their kind logged);
// development and tests use the in-memory DevMailbox, shown at GET /dev/mailbox on this service (never routed by the
// gateway). Tokens are never logged.
import { randomUUID } from 'node:crypto';
import type { Logger, LoggerService } from '@nestjs/common';
import { DevMailbox, type BackgroundMailer, type MailOutcome } from '@smartconnect/backend-kit';
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
  /** `onSettled`: the final outcome of a message a background notifier queued (never called by the others). */
  send(message: InvitationMessage, onSettled?: (outcome: MailOutcome) => void): Promise<void>;
  /**
   * What a resolved `send` means: delivered ("immediate", the default: the dev mailbox), queued and reported later
   * through `onSettled` ("background": SMTP), or dropped on purpose ("disabled").
   */
  readonly delivery?: 'immediate' | 'background' | 'disabled';
}

/** Where an invitation's latest email stands, as the inviter sees it. */
export type InvitationDelivery = 'queued' | 'sent' | 'failed' | 'disabled' | 'unknown';

export const INVITATION_NOTIFIER = Symbol('INVITATION_NOTIFIER');

export class DisabledInvitationNotifier implements InvitationNotifier {
  readonly delivery = 'disabled';

  constructor(private readonly logger: LoggerService) {}

  send(message: InvitationMessage): Promise<void> {
    this.logger.warn({ event: 'invitation_notification_dropped', kind: message.kind }, 'InvitationNotifier');
    return Promise.resolve();
  }
}

export class InvitationDevMailbox extends DevMailbox<InvitationMessage> implements InvitationNotifier {}

/**
 * Delivery happens after the transaction committed. A failure is logged (kind only), never undoes the invitation, and
 * is reported to the caller, who shows it to the inviter: an invitation whose email failed is resent, never silently
 * left unusable.
 */
export async function notifySafely(
  notifier: InvitationNotifier,
  logger: Logger,
  message: InvitationMessage,
  onSettled?: (outcome: MailOutcome) => void,
): Promise<Exclude<InvitationDelivery, 'unknown'>> {
  try {
    await notifier.send(message, onSettled);
    return notifier.delivery === 'background' ? 'queued' : notifier.delivery === 'disabled' ? 'disabled' : 'sent';
  } catch (error) {
    // The error's name only: its message may carry an address or a server reply.
    logger.error({ event: 'invitation_notification_failed', kind: message.kind, error: errorSummary(error) });
    return 'failed';
  }
}

/**
 * The latest email of each invitation, as this process knows it: queued, sent, failed or disabled, for the invitation's
 * CURRENT link (its token hash: an outcome for a link a resend replaced is ignored). In memory and bounded: after a
 * restart, or on another instance, it is "unknown". Durable tracking would need columns on organization_invitations
 * (a schema change, not made here).
 */
export class InvitationDeliveries {
  private readonly entries = new Map<string, { tokenHash: string; status: Exclude<InvitationDelivery, 'unknown'> }>();

  constructor(private readonly capacity = 10_000) {}

  record(invitationId: string, tokenHash: string, status: Exclude<InvitationDelivery, 'unknown'>): void {
    this.entries.delete(invitationId); // re-inserted last: the oldest entry is the first evicted
    this.entries.set(invitationId, { tokenHash, status });
    if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
  }

  settle(invitationId: string, tokenHash: string, outcome: MailOutcome): void {
    const entry = this.entries.get(invitationId);
    if (entry?.tokenHash === tokenHash) entry.status = outcome;
  }

  of(invitationId: string, tokenHash: string): InvitationDelivery {
    const entry = this.entries.get(invitationId);
    return entry?.tokenHash === tokenHash ? entry.status : 'unknown';
  }
}

export const INVITATION_DELIVERIES = Symbol('INVITATION_DELIVERIES');

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
  readonly delivery = 'background';

  constructor(private readonly mailer: Pick<BackgroundMailer, 'enqueue' | 'close'>) {}

  send(message: InvitationMessage, onSettled?: (outcome: MailOutcome) => void): Promise<void> {
    const { subject, html, text } = invitationEmail(message);
    this.mailer.enqueue(message.kind, { to: message.to, subject, html, text, idempotencyKey: randomUUID() }, onSettled);
    return Promise.resolve();
  }

  /** Nest calls this on shutdown (enableShutdownHooks): finish what is queued, then close the connections. */
  async onApplicationShutdown(): Promise<void> {
    await this.mailer.close();
  }
}
