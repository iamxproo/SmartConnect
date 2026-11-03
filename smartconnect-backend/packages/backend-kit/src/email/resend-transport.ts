// Transactional email through Resend's HTTP API (ADR 0012, Proposed), using Node's own fetch: no SDK, no NestJS. Each
// service's notifier adapter (identity's AccountNotifier, organization's InvitationNotifier) renders its messages and
// hands them to one ResendTransport.
//
// Nothing secret or personal leaves this module, in an error or otherwise: not the API key, the recipient, the subject,
// the bodies (which carry one-time links) or the provider's error message. Errors carry a category, the HTTP status and
// the provider's error name once sanitized. The module never logs; callers log those safe fields.
import { parseInteger, parseServiceUrl, readSecret, type Env } from '../config/env.js';
import {
  EmailDeliveryError,
  isEmailAddress,
  isEmailSender,
  refuseInvalidMessage,
  type EmailMessage,
} from './delivery.js';

// The shared types and checks live in delivery.ts; they stay importable from here.
export {
  EmailDeliveryError,
  isEmailAddress,
  isEmailSender,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  type EmailFailureCategory,
  type EmailMessage,
  type EmailTransport,
} from './delivery.js';

export const DEFAULT_RESEND_API_URL = 'https://api.resend.com';
export const DEFAULT_EMAIL_TIMEOUT_MS = 10_000;
/** Resend refuses requests without a User-Agent (403). */
const USER_AGENT = 'smartconnect-backend-kit';
/** A misconfigured RESEND_API_URL could answer with anything: larger bodies are not read. */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Printable ASCII without spaces: an API key. */
const TOKEN = /^[\x21-\x7e]+$/;
/** Provider error names look like `rate_limit_exceeded`; anything else (a message, an address) is dropped. */
const PROVIDER_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export interface ResendConfig {
  apiKey: string;
  /** `https://api.resend.com`, or a local fake server in tests. */
  apiUrl: string;
  /** `address` or `Name <address>`, on a domain verified with Resend. */
  from: string;
  replyTo?: string;
  timeoutMs: number;
}

/**
 * Resend settings, for a service's configuration loader when it sends through Resend: `RESEND_API_KEY` (or
 * `RESEND_API_KEY_FILE`), `EMAIL_FROM`, optional `EMAIL_REPLY_TO`, `RESEND_API_URL` and `EMAIL_TIMEOUT_MS`. Problems name
 * the variable, never its value. `production` requires an https API URL.
 */
export function parseResendConfig(env: Env, problems: string[], options: { production?: boolean } = {}): ResendConfig {
  const apiKey = readSecret(env, 'RESEND_API_KEY', problems);
  if (apiKey === undefined && env.RESEND_API_KEY_FILE === undefined)
    problems.push('RESEND_API_KEY (or RESEND_API_KEY_FILE) is required to send email through Resend');
  else if (apiKey !== undefined && !TOKEN.test(apiKey))
    problems.push('RESEND_API_KEY must be a single token without spaces or control characters');

  const from = env.EMAIL_FROM?.trim();
  if (!from) problems.push('EMAIL_FROM is required: an address, or "Name <address>", on a domain verified with Resend');
  else if (!isEmailSender(from)) problems.push('EMAIL_FROM must be an address, or "Name <address>"');

  const replyTo = env.EMAIL_REPLY_TO?.trim() || undefined;
  if (replyTo !== undefined && !isEmailAddress(replyTo)) problems.push('EMAIL_REPLY_TO must be an email address');

  let apiUrl = DEFAULT_RESEND_API_URL;
  if (env.RESEND_API_URL !== undefined) {
    apiUrl = parseServiceUrl('RESEND_API_URL', env.RESEND_API_URL, problems);
    if (options.production && apiUrl !== '' && !apiUrl.startsWith('https://'))
      problems.push('RESEND_API_URL must be https in production');
  }
  const timeoutMs = parseInteger(
    'EMAIL_TIMEOUT_MS',
    env.EMAIL_TIMEOUT_MS ?? String(DEFAULT_EMAIL_TIMEOUT_MS),
    1000,
    60_000,
    problems,
  );
  return { apiKey: apiKey ?? '', apiUrl, from: from ?? '', ...(replyTo && { replyTo }), timeoutMs };
}

export class ResendTransport {
  constructor(
    private readonly config: ResendConfig,
    /** Tests may pass their own; production uses the global fetch. */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Resolves with the provider's message id; rejects only with EmailDeliveryError. */
  async send(message: EmailMessage): Promise<{ id: string }> {
    refuseInvalidMessage(message);
    const { from, replyTo, apiKey, apiUrl, timeoutMs } = this.config;
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${apiUrl}/emails`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': USER_AGENT,
          'idempotency-key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(replyTo && { reply_to: replyTo }),
        }),
        // A redirect would carry the key elsewhere; the API never redirects.
        redirect: 'manual',
        signal,
      });
    } catch {
      // The underlying error is dropped on purpose: its message is not ours to vouch for.
      throw new EmailDeliveryError(signal.aborted ? 'timeout' : 'network', true);
    }

    let body: unknown;
    try {
      body = await readJson(res);
    } catch {
      // The status arrived but the body did not. For a success, the outcome is unknown: retrying with the same
      // idempotency key is safe. For a failure, the status alone decides.
      if (res.ok) throw new EmailDeliveryError(signal.aborted ? 'timeout' : 'network', true, res.status);
    }
    if (res.ok) {
      const id = (body as { id?: unknown } | undefined)?.id;
      if (typeof id === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(id)) return { id };
      throw new EmailDeliveryError('unexpected_response', false, res.status);
    }
    throw classify(res, providerCodeOf(body));
  }
}

async function readJson(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_RESPONSE_BYTES) {
    await res.body?.cancel();
    return undefined;
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function providerCodeOf(body: unknown): string | undefined {
  const name = (body as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' && PROVIDER_CODE.test(name) ? name : undefined;
}

function classify(res: Response, code: string | undefined): EmailDeliveryError {
  const { status } = res;
  if (status === 429) {
    const retryAfter = res.headers.get('retry-after');
    const seconds = retryAfter !== null && /^\d{1,5}$/.test(retryAfter) ? Number(retryAfter) : undefined;
    return new EmailDeliveryError('rate_limited', true, status, code, seconds);
  }
  if (status >= 500 && status <= 599) return new EmailDeliveryError('provider_error', true, status, code);
  if (status === 400 || status === 422) return new EmailDeliveryError('rejected', false, status, code);
  if (status === 401 || status === 403) return new EmailDeliveryError('unauthorized', false, status, code);
  // Same key while the first request still runs: safe to retry with that key. Same key, different body: never.
  if (status === 409)
    return new EmailDeliveryError('conflict', code === 'concurrent_idempotent_requests', status, code);
  return new EmailDeliveryError('unexpected_response', false, status, code);
}
