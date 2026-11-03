import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundMailer, type MailerLogger } from '../src/email/background-mailer.js';
import { EmailDeliveryError, type EmailMessage, type EmailTransport } from '../src/email/delivery.js';

const message: EmailMessage = {
  to: 'ada.lovelace@example.com',
  subject: 'Reset your password',
  html: '<a href="https://app.example.com/reset-password#token=SECRETTOKEN">Reset</a>',
  text: 'https://app.example.com/reset-password#token=SECRETTOKEN',
  idempotencyKey: 'k1',
};

function logger() {
  const records: { level: string; record: unknown }[] = [];
  const l: MailerLogger = {
    log: (record) => records.push({ level: 'log', record }),
    warn: (record) => records.push({ level: 'warn', record }),
    error: (record) => records.push({ level: 'error', record }),
  };
  return { l, records };
}
const transient = () => new EmailDeliveryError('provider_error', true, 451, 'EENVELOPE');
const permanent = () => new EmailDeliveryError('rejected', false, 550, 'EENVELOPE');

describe('BackgroundMailer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => vi.useRealTimers());

  it('returns from enqueue immediately, even when the transport hangs', () => {
    const { l } = logger();
    const mailer = new BackgroundMailer({ send: () => new Promise(() => undefined) }, l);
    expect(mailer.enqueue('password_reset', message)).toBeUndefined();
  });

  it('sends and logs the kind and attempts only', async () => {
    const { l, records } = logger();
    const send = vi.fn().mockResolvedValue({ id: '<id@example.com>' });
    const mailer = new BackgroundMailer({ send }, l);
    mailer.enqueue('email_verification', message);
    await mailer.drain(1000);
    expect(send).toHaveBeenCalledWith(message);
    expect(records).toEqual([
      { level: 'log', record: { event: 'email_sent', kind: 'email_verification', attempts: 1 } },
    ]);
  });

  it('retries retryable failures with exponential backoff, then succeeds', async () => {
    const { l, records } = logger();
    const send = vi
      .fn()
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockResolvedValue({ id: null });
    const mailer = new BackgroundMailer({ send }, l, { baseDelayMs: 1000 });
    mailer.enqueue('password_reset', message);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(3);
    await mailer.drain(1000);
    expect(records.at(-1)).toEqual({
      level: 'log',
      record: { event: 'email_sent', kind: 'password_reset', attempts: 3 },
    });
  });

  it('gives up after maxAttempts and logs only safe fields', async () => {
    const { l, records } = logger();
    const send = vi.fn().mockRejectedValue(transient());
    const mailer = new BackgroundMailer({ send }, l, { maxAttempts: 3 });
    mailer.enqueue('password_reset', message);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(3);
    expect(records).toEqual([
      {
        level: 'error',
        record: {
          event: 'email_delivery_failed',
          kind: 'password_reset',
          category: 'provider_error',
          status: 451,
          providerCode: 'EENVELOPE',
          attempts: 3,
        },
      },
    ]);
    const dump = JSON.stringify(records);
    for (const secret of ['ada.lovelace', 'Reset your password', 'SECRETTOKEN', 'reset-password'])
      expect(dump).not.toContain(secret);
  });

  it('does not retry permanent failures, nor errors it does not know', async () => {
    const { l, records } = logger();
    const send = vi
      .fn()
      .mockRejectedValueOnce(permanent())
      .mockRejectedValueOnce(new Error('ada.lovelace@example.com'));
    const mailer = new BackgroundMailer({ send }, l);
    mailer.enqueue('a', message);
    mailer.enqueue('b', message);
    await mailer.drain(1000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(records.map((r) => r.record)).toEqual([
      expect.objectContaining({
        event: 'email_delivery_failed',
        kind: 'a',
        category: 'rejected',
        status: 550,
        attempts: 1,
      }),
      expect.objectContaining({
        event: 'email_delivery_failed',
        kind: 'b',
        category: 'unexpected_response',
        attempts: 1,
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain('ada.lovelace');
  });

  it('honours retryAfterSeconds as a floor for the delay', async () => {
    const { l } = logger();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new EmailDeliveryError('rate_limited', true, 429, undefined, 5))
      .mockResolvedValue({ id: null });
    const mailer = new BackgroundMailer({ send }, l, { baseDelayMs: 100 });
    mailer.enqueue('a', message);
    await vi.advanceTimersByTimeAsync(4999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('caps the backoff at maxDelayMs', async () => {
    const { l } = logger();
    const send = vi.fn().mockRejectedValue(transient());
    const mailer = new BackgroundMailer({ send }, l, { baseDelayMs: 1000, maxDelayMs: 1500, maxAttempts: 4 });
    mailer.enqueue('a', message);
    await vi.advanceTimersByTimeAsync(1000 + 1500 + 1500);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('runs at most `concurrency` sends at once and queues the rest', async () => {
    const { l } = logger();
    const releases: (() => void)[] = [];
    let running = 0;
    let peak = 0;
    const send = vi.fn(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running--;
      return { id: null };
    });
    const mailer = new BackgroundMailer({ send }, l, { concurrency: 2 });
    for (let i = 0; i < 5; i++) mailer.enqueue('a', message);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
    releases.splice(0).forEach((release) => release());
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(4);
    releases.splice(0).forEach((release) => release());
    await vi.advanceTimersByTimeAsync(0);
    releases.splice(0).forEach((release) => release());
    await mailer.drain(1000);
    expect(send).toHaveBeenCalledTimes(5);
    expect(peak).toBe(2);
  });

  it('drops mail when the queue is full and says so, without personal data', () => {
    const { l, records } = logger();
    const send = vi.fn(() => new Promise<{ id: null }>(() => undefined));
    const mailer = new BackgroundMailer({ send }, l, { concurrency: 1, maxQueue: 2 });
    for (let i = 0; i < 5; i++) mailer.enqueue('password_reset', message); // 1 running, 2 queued, 2 dropped
    expect(records).toEqual([
      { level: 'error', record: { event: 'email_queue_full', kind: 'password_reset' } },
      { level: 'error', record: { event: 'email_queue_full', kind: 'password_reset' } },
    ]);
  });

  it('drain waits for in-flight and queued sends, and gives up at its timeout', async () => {
    const { l } = logger();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const send = vi.fn(async () => {
      await gate;
      return { id: null };
    });
    const mailer = new BackgroundMailer({ send }, l, { concurrency: 1 });
    mailer.enqueue('a', message);
    mailer.enqueue('b', message);

    let drained = false;
    void mailer.drain(10_000).then(() => (drained = true));
    await vi.advanceTimersByTimeAsync(5000);
    expect(drained).toBe(false);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);

    const stuck = new BackgroundMailer({ send: () => new Promise(() => undefined) }, l);
    stuck.enqueue('a', message);
    let gaveUp = false;
    void stuck.drain(2000).then(() => (gaveUp = true));
    await vi.advanceTimersByTimeAsync(2000);
    expect(gaveUp).toBe(true);
  });

  it('close drains, then closes a transport that can be closed', async () => {
    const { l } = logger();
    const close = vi.fn();
    const send = vi.fn().mockResolvedValue({ id: null });
    const transport: EmailTransport & { close(): void } = { send, close };
    const mailer = new BackgroundMailer(transport, l);
    mailer.enqueue('a', message);
    await mailer.close();
    expect(send).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(new BackgroundMailer({ send: vi.fn() }, l).close()).resolves.toBeUndefined();
  });
});
