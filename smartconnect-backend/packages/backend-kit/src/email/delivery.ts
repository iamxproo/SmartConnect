// What every email transport shares (ADR 0012): the message, the one error type, and the checks made before sending.
// Nothing here is NestJS-specific.

export interface EmailMessage {
  /** One recipient. */
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Sending the same key again within 24 hours never sends twice (Resend). Derive it from non-secret data, for example
   * the message kind and a token's hash: never from a raw token.
   */
  idempotencyKey: string;
}

export type EmailFailureCategory =
  /** Refused before sending: a programming error in the caller. */
  | 'invalid_message'
  /** No response before the message was handed over: connection refused or reset, DNS failure. */
  | 'network'
  | 'timeout'
  /** 429 (Resend): rate limit, or a daily or monthly quota. */
  | 'rate_limited'
  /** 5xx (Resend), or an SMTP 4xx reply: the provider is busy or failing. */
  | 'provider_error'
  /** 400, 422 (Resend), or an SMTP 5xx reply: the request itself was invalid. */
  | 'rejected'
  /** 401, 403 (Resend), or SMTP authentication refused: key missing, invalid or restricted; sending domain not verified; quota. */
  | 'unauthorized'
  /** 409: the idempotency key clashes with another request. */
  | 'conflict'
  /** Anything else, including a success response without a message id and an SMTP failure during or after DATA (the server may have accepted the message: never retried). */
  | 'unexpected_response';

/** The only error an email transport (`ResendTransport`, `SmtpTransport`) rejects with. Every field is safe to log. */
export class EmailDeliveryError extends Error {
  constructor(
    readonly category: EmailFailureCategory,
    /** Whether sending the same message, with the same idempotency key, again later may succeed. */
    readonly retryable: boolean,
    readonly status?: number,
    /** The provider's error name (e.g. `rate_limit_exceeded`), kept only if it has that shape. */
    readonly providerCode?: string,
    /** Seconds the provider asked to wait (429 `retry-after`). */
    readonly retryAfterSeconds?: number,
    /** For `invalid_message`: which field was refused (the name, never the value). */
    readonly field?: keyof EmailMessage,
  ) {
    super(
      `email delivery failed: ${category}${field ? ` (${field})` : ''}${status === undefined ? '' : ` (status ${status})`}`,
    );
    this.name = 'EmailDeliveryError';
  }
}

/** Resend keeps idempotency keys for 24 hours; longer keys are refused. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
// eslint-disable-next-line no-control-regex -- a display name must not contain control characters
const SENDER = /^([^<>"\u0000-\u001f\u007f]{1,100}) <([^<>]+)>$/;
// eslint-disable-next-line no-control-regex -- neither must a subject (no header injection)
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Printable ASCII without spaces: an API key or an idempotency key. */
const TOKEN = /^[\x21-\x7e]+$/;

export const isEmailAddress = (value: string): boolean => value.length <= 254 && ADDRESS.test(value);

/** `address`, or `Display Name <address>`. */
export function isEmailSender(value: string): boolean {
  const named = SENDER.exec(value);
  return named ? named[1]!.trim() !== '' && isEmailAddress(named[2]!) : isEmailAddress(value);
}
/** Throws EmailDeliveryError('invalid_message') naming the field, never its value. */
export function refuseInvalidMessage(message: EmailMessage): void {
  const refuse = (field: keyof EmailMessage) =>
    new EmailDeliveryError('invalid_message', false, undefined, undefined, undefined, field);
  if (!isEmailAddress(message.to)) throw refuse('to');
  if (!message.subject || message.subject.length > 998 || CONTROL.test(message.subject)) throw refuse('subject');
  if (!message.html) throw refuse('html');
  if (typeof message.text !== 'string') throw refuse('text');
  if (message.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH || !TOKEN.test(message.idempotencyKey))
    throw refuse('idempotencyKey');
}

/** What a service's notifier adapter needs from a transport. */
export interface EmailTransport {
  send(message: EmailMessage): Promise<{ id: string | null }>;
}
