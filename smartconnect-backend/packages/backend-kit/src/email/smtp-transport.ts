// Transactional email over SMTP (Gmail with an app password, or any provider) through Nodemailer; NestJS-independent.
// Same promises as the Resend transport (ADR 0012): nothing secret or personal leaves this module, in an error or
// otherwise. Not the password, the user, the recipient, the subject, the bodies (which carry one-time links) or the
// server's reply text. Errors carry a category, a retry flag, the SMTP reply code and a sanitized Nodemailer code. The
// module never logs (Nodemailer's own logging is off); callers log those safe fields.
//
// TLS is mandatory: with SMTP_SECURE=false the connection upgrades through STARTTLS and Nodemailer refuses to send
// credentials or mail if the server does not offer it. No environment variable can turn that off; only the second
// constructor argument can, and only tests pass it.
import nodemailer, { type NodemailerError, type SMTPPoolOptions, type Transporter } from 'nodemailer';
import { parseBoolean, parseInteger, readSecret, type Env } from '../config/env.js';
import {
  EmailDeliveryError,
  isEmailAddress,
  isEmailSender,
  refuseInvalidMessage,
  type EmailFailureCategory,
  type EmailMessage,
  type EmailTransport,
} from './delivery.js';

export const DEFAULT_SMTP_PORT = 587;
export const DEFAULT_SMTP_TIMEOUT_MS = 15_000;

const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
// eslint-disable-next-line no-control-regex -- a user name must not contain control characters
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Nodemailer error codes look like `EAUTH`; anything else is dropped. */
const PROVIDER_CODE = /^[A-Z]{2,20}$/;

export interface SmtpConfig {
  host: string;
  port: number;
  /** true: TLS from the first byte (port 465). false: STARTTLS, required. */
  secure: boolean;
  user: string;
  password: string;
  /** `address` or `Name <address>`; Gmail rewrites other addresses to the account's own. */
  from: string;
  replyTo?: string;
  /** Connection, greeting and socket timeout. */
  timeoutMs: number;
}

/**
 * SMTP settings, for a service's configuration loader when it sends through SMTP: `SMTP_HOST`, `SMTP_PORT` (587),
 * `SMTP_SECURE` (false: STARTTLS), `SMTP_USER`, `SMTP_PASSWORD` (or `SMTP_PASSWORD_FILE`; spaces are removed, Google
 * shows app passwords in four groups), `SMTP_FROM`, optional `SMTP_REPLY_TO`, `SMTP_TIMEOUT_MS`. Problems name the
 * variable, never its value. `production` is accepted for symmetry with the other parsers: TLS is always required.
 */
export function parseSmtpConfig(env: Env, problems: string[], _options: { production?: boolean } = {}): SmtpConfig {
  const host = env.SMTP_HOST?.trim();
  if (!host) problems.push('SMTP_HOST is required to send email through SMTP');
  else if (!HOST.test(host)) problems.push('SMTP_HOST must be a host name or IP address');

  const port = parseInteger('SMTP_PORT', env.SMTP_PORT ?? String(DEFAULT_SMTP_PORT), 1, 65535, problems);
  const secure = env.SMTP_SECURE === undefined ? false : parseBoolean('SMTP_SECURE', env.SMTP_SECURE, problems);

  const user = env.SMTP_USER?.trim();
  if (!user) problems.push('SMTP_USER is required to send email through SMTP');
  else if (CONTROL.test(user)) problems.push('SMTP_USER must not contain control characters');

  const raw = readSecret(env, 'SMTP_PASSWORD', problems);
  if (raw === undefined && env.SMTP_PASSWORD_FILE === undefined)
    problems.push('SMTP_PASSWORD (or SMTP_PASSWORD_FILE) is required to send email through SMTP');
  const password = raw?.replace(/\s+/g, '');

  const from = env.SMTP_FROM?.trim();
  if (!from) problems.push('SMTP_FROM is required: an address, or "Name <address>"');
  else if (!isEmailSender(from)) problems.push('SMTP_FROM must be an address, or "Name <address>"');

  const replyTo = env.SMTP_REPLY_TO?.trim() || undefined;
  if (replyTo !== undefined && !isEmailAddress(replyTo)) problems.push('SMTP_REPLY_TO must be an email address');

  const timeoutMs = parseInteger(
    'SMTP_TIMEOUT_MS',
    env.SMTP_TIMEOUT_MS ?? String(DEFAULT_SMTP_TIMEOUT_MS),
    1000,
    60_000,
    problems,
  );
  return {
    host: host ?? '',
    port,
    secure,
    user: user ?? '',
    password: password ?? '',
    from: from ?? '',
    ...(replyTo && { replyTo }),
    timeoutMs,
  };
}

/** TEST ONLY: lets a suite talk to a plain local fake server. Production code never passes these. */
export interface SmtpTestOptions {
  requireTLS?: boolean;
  ignoreTLS?: boolean;
}

export class SmtpTransport implements EmailTransport {
  private readonly transporter: Transporter;

  constructor(
    private readonly config: SmtpConfig,
    testOptions: SmtpTestOptions = {},
  ) {
    const options: SMTPPoolOptions = {
      pool: true,
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: !config.secure,
      auth: { user: config.user, pass: config.password },
      maxConnections: 2,
      // The mailer retries, with backoff; the pool must not silently resend a message whose connection dropped.
      maxRequeues: 0,
      connectionTimeout: config.timeoutMs,
      greetingTimeout: config.timeoutMs,
      // Longer than the greeting wait, so a silent server is always reported as a greeting timeout (retryable).
      socketTimeout: config.timeoutMs * 2,
      tls: { minVersion: 'TLSv1.2' },
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
      ...testOptions,
    };
    this.transporter = nodemailer.createTransport(options);
  }

  /** Resolves with the Message-ID the server was given; rejects only with EmailDeliveryError. */
  async send(message: EmailMessage): Promise<{ id: string | null }> {
    refuseInvalidMessage(message);
    const { from, replyTo } = this.config;
    try {
      const info = await this.transporter.sendMail({
        from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(replyTo && { replyTo }),
      });
      return { id: typeof info.messageId === 'string' ? info.messageId : null };
    } catch (error) {
      throw classifySmtpError(error);
    }
  }

  /** Checks the connection and the credentials without sending. Rejects only with EmailDeliveryError. */
  async verify(): Promise<void> {
    try {
      await this.transporter.verify();
    } catch (error) {
      throw classifySmtpError(error);
    }
  }

  close(): void {
    this.transporter.close();
  }
}

/** Commands that run before any message data is handed over. */
const BEFORE_DATA = /^(CONN|EHLO|HELO|LHLO|STARTTLS|AUTH.*|MAIL FROM|RCPT TO|API)?$/;

/**
 * Maps a Nodemailer error to a safe EmailDeliveryError by `code`, `responseCode` and `command` only: never by its
 * message or response text, which carry addresses and server banners. No `cause` is attached.
 */
export function classifySmtpError(error: unknown): EmailDeliveryError {
  const e = (typeof error === 'object' && error !== null ? error : {}) as Partial<NodemailerError>;
  const code = typeof e.code === 'string' && PROVIDER_CODE.test(e.code) ? e.code : undefined;
  const status =
    typeof e.responseCode === 'number' && e.responseCode >= 200 && e.responseCode <= 599 ? e.responseCode : undefined;
  const command = typeof e.command === 'string' ? e.command : undefined;
  const fail = (category: EmailFailureCategory, retryable: boolean) =>
    new EmailDeliveryError(category, retryable, status, code);

  if (code === 'EAUTH' || code === 'ENOAUTH' || status === 534 || status === 535) return fail('unauthorized', false);
  // During or after DATA the server may already have accepted the message: retrying could send it twice.
  if (command === 'DATA') return fail('unexpected_response', false);
  if (code === 'ETIMEDOUT')
    // An idle-socket timeout can strike while the server is still taking the message; the others precede DATA.
    return e.timeoutType === 'SOCKET_TIMEOUT' ? fail('unexpected_response', false) : fail('timeout', true);
  if (status !== undefined && status >= 400 && status <= 499) return fail('provider_error', true);
  if (status !== undefined && status >= 500) return fail('rejected', false);
  if (code === 'EENVELOPE' || code === 'EMESSAGE') return fail('invalid_message', false);
  if (code === 'ECONNECTION' || code === 'EDNS' || code === 'ESOCKET' || code === 'ETLS')
    return BEFORE_DATA.test(command ?? '') ? fail('network', true) : fail('unexpected_response', false);
  return fail('unexpected_response', false);
}
