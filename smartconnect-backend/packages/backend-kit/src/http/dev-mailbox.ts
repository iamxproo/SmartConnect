// DEVELOPMENT AND TESTS ONLY. No email provider is approved yet (ADR 0009), so services that send email (identity,
// organization) keep outgoing messages in memory and show them at GET /dev/mailbox on the service itself. Services
// register this only outside production; the gateway has no route to it. Messages are never logged.
import { Controller, Get, Header, Inject, Query, RequestMethod } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../auth/guard.js';

export interface MailMessage {
  kind: string;
  to: string;
}

export class DevMailbox<T extends MailMessage = MailMessage> {
  private static readonly CAPACITY = 50;
  private readonly messages: (T & { sentAt: Date })[] = [];

  send(message: T): Promise<void> {
    this.messages.push({ ...message, sentAt: new Date() });
    if (this.messages.length > DevMailbox.CAPACITY) this.messages.shift();
    return Promise.resolve();
  }

  /** Newest first, optionally only the messages to one address. */
  list(to?: string): (T & { sentAt: Date })[] {
    const all = [...this.messages].reverse();
    return to === undefined ? all : all.filter((message) => message.to.toLowerCase() === to.toLowerCase());
  }
}

/** Injection token for the service's DevMailbox instance. */
export const DEV_MAILBOX = Symbol('DEV_MAILBOX');

/** Served outside /api/v1; pass DEV_MAILBOX_ROUTE in `unprefixedRoutes`. */
export const DEV_MAILBOX_ROUTE = { path: 'dev/mailbox', method: RequestMethod.GET };

@ApiExcludeController()
@Public()
@Controller('dev/mailbox')
export class DevMailboxController {
  constructor(@Inject(DEV_MAILBOX) private readonly mailbox: DevMailbox) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query('to') to?: string) {
    return { data: this.mailbox.list(to) };
  }
}
