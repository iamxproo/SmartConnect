// Sends email off the request path (ADR 0012): `enqueue` returns at once, so a handler never waits for the mail server
// and "forgot password" answers in the same time whether or not an account exists. A small in-memory queue with bounded
// concurrency retries transient failures with exponential backoff and jitter. The queue is lost on a crash; the
// callers' flows (verification resend, forgot password) all let the person ask again.
//
// Logs carry the message kind and delivery facts only: never the recipient, subject, bodies, links or tokens.
import { EmailDeliveryError, type EmailMessage, type EmailTransport } from './delivery.js';

/** The part of Nest's LoggerService the mailer uses. Structured records only. */
export interface MailerLogger {
  log(message: unknown, context?: string): unknown;
  warn(message: unknown, context?: string): unknown;
  error(message: unknown, ...optional: unknown[]): unknown;
}

export interface BackgroundMailerOptions {
  /** Sends per message, the first included. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Sends in flight at once. */
  concurrency?: number;
  /** Messages waiting; more are dropped. */
  maxQueue?: number;
}

const CONTEXT = 'BackgroundMailer';

interface Job {
  kind: string;
  message: EmailMessage;
}

export class BackgroundMailer {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly concurrency: number;
  private readonly maxQueue: number;
  private readonly queue: Job[] = [];
  private active = 0;
  private idle: (() => void)[] = [];

  constructor(
    private readonly transport: EmailTransport,
    private readonly logger: MailerLogger,
    options: BackgroundMailerOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.concurrency = options.concurrency ?? 2;
    this.maxQueue = options.maxQueue ?? 1000;
  }

  /** Never throws and never waits for delivery. A full queue drops the message and says so. */
  enqueue(kind: string, message: EmailMessage): void {
    if (this.queue.length >= this.maxQueue) {
      this.logger.error({ event: 'email_queue_full', kind }, CONTEXT);
      return;
    }
    this.queue.push({ kind, message });
    this.pump();
  }

  /** Resolves when nothing is queued or in flight, or after `timeoutMs`, whichever comes first. */
  async drain(timeoutMs: number): Promise<void> {
    if (this.settled()) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      this.idle.push(done);
    });
  }

  /** Drains (up to 5 s), then closes the transport if it can be closed. */
  async close(): Promise<void> {
    await this.drain(5000);
    (this.transport as { close?: () => void }).close?.();
  }

  private settled(): boolean {
    return this.active === 0 && this.queue.length === 0;
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.active++;
      void this.run(job).finally(() => {
        this.active--;
        this.pump();
        if (this.settled()) {
          const waiting = this.idle;
          this.idle = [];
          for (const resolve of waiting) resolve();
        }
      });
    }
  }

  private async run({ kind, message }: Job): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.transport.send(message);
        this.logger.log({ event: 'email_sent', kind, attempts: attempt }, CONTEXT);
        return;
      } catch (error) {
        const known = error instanceof EmailDeliveryError ? error : undefined;
        if (known?.retryable && attempt < this.maxAttempts) {
          await sleep(this.delayFor(attempt, known.retryAfterSeconds));
          continue;
        }
        this.logger.error(
          {
            event: 'email_delivery_failed',
            kind,
            category: known?.category ?? 'unexpected_response',
            status: known?.status,
            providerCode: known?.providerCode,
            attempts: attempt,
          },
          CONTEXT,
        );
        return;
      }
    }
  }

  /** Exponential backoff with up to 25% jitter; a provider's retry-after is a floor. */
  private delayFor(attempt: number, retryAfterSeconds?: number): number {
    const backoff = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
    const jittered = Math.min(this.maxDelayMs, backoff * (1 + Math.random() * 0.25));
    return Math.max(jittered, (retryAfterSeconds ?? 0) * 1000);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
