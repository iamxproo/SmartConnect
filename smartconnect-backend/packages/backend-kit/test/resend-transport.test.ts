// The Resend transport against a local fake HTTP server: nothing here reaches Resend or the internet.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EmailDeliveryError,
  parseResendConfig,
  ResendTransport,
  type EmailMessage,
  type ResendConfig,
} from '../src/email/resend-transport.js';

const API_KEY = 're_test_9f2c1d0b7a6e5d4c3b2a1';
const TOKEN = 'Zq3x-raw-one-time-token_abcdefghijklmnopqrstu';
const message: EmailMessage = {
  to: 'ada.lovelace@example.com',
  subject: 'Verify your email address',
  html: `<p>Hello Ada</p><a href="https://app.example.com/verify-email#token=${TOKEN}">Verify</a>`,
  text: `Hello Ada. Verify: https://app.example.com/verify-email#token=${TOKEN}`,
  idempotencyKey: 'email_verification:3f6b1c0e9d8a7b6c5d4e3f2a1b0c9d8e',
};
/** What must never appear in an error (or a log line): the key, the recipient, the content, the provider's text. */
const SECRETS = [API_KEY, message.to, 'ada.lovelace', TOKEN, message.subject, 'Hello Ada', 'provider says'];

interface Recorded {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body: string;
}

let server: Server;
let baseUrl: string;
let requests: Recorded[];
let respond: (res: ServerResponse) => void;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      respond(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  requests = [];
  respond = json(200, { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' });
});

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return (res: ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
}

const transport = (overrides: Partial<ResendConfig> = {}) =>
  new ResendTransport({
    apiKey: API_KEY,
    apiUrl: baseUrl,
    from: 'SmartConnect <no-reply@mail.example.com>',
    timeoutMs: 2_000,
    ...overrides,
  });

async function failure(promise: Promise<unknown>): Promise<EmailDeliveryError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(EmailDeliveryError);
  return error as EmailDeliveryError;
}

/** Every way an error can be shown or logged contains none of the secrets. */
function expectNothingSensitive(error: EmailDeliveryError) {
  for (const shown of [error.message, String(error), JSON.stringify(error), inspect(error), error.stack ?? '']) {
    for (const secret of SECRETS) expect(shown).not.toContain(secret);
  }
  expect(error.cause).toBeUndefined();
}

describe('ResendTransport: the request', () => {
  it('POSTs one JSON email to {apiUrl}/emails with Bearer auth, a User-Agent and the idempotency key', async () => {
    const result = await transport({ replyTo: 'support@example.com' }).send(message);

    expect(result).toEqual({ id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' });
    expect(requests).toHaveLength(1);
    const [request] = requests as [Recorded];
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/emails');
    expect(request.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers['user-agent']).toBe('smartconnect-backend-kit');
    expect(request.headers['idempotency-key']).toBe(message.idempotencyKey);
    expect(JSON.parse(request.body)).toEqual({
      from: 'SmartConnect <no-reply@mail.example.com>',
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
      reply_to: 'support@example.com',
    });
  });

  it('leaves reply_to out unless configured', async () => {
    await transport().send(message);
    expect(JSON.parse(requests[0]!.body)).not.toHaveProperty('reply_to');
  });

  it('never follows a redirect (it would carry the key elsewhere)', async () => {
    respond = (res) => {
      res.writeHead(307, { location: `${baseUrl}/elsewhere` });
      res.end();
    };
    const error = await failure(transport().send(message));
    expect(error).toMatchObject({ category: 'unexpected_response', retryable: false, status: 307 });
    expect(requests.map((r) => r.url)).toEqual(['/emails']);
  });

  it.each<[string, Partial<EmailMessage>, keyof EmailMessage]>([
    ['a malformed recipient', { to: 'not-an-address' }, 'to'],
    ['two recipients', { to: 'a@example.com, b@example.com' }, 'to'],
    ['a line break in the subject', { subject: 'Hi\r\nBcc: someone@example.com' }, 'subject'],
    ['an empty subject', { subject: '' }, 'subject'],
    ['an empty HTML body', { html: '' }, 'html'],
    ['an idempotency key with spaces', { idempotencyKey: 'has spaces' }, 'idempotencyKey'],
    ['an idempotency key over 256 characters', { idempotencyKey: 'k'.repeat(257) }, 'idempotencyKey'],
  ])('refuses %s before sending anything', async (_case, change, field) => {
    const error = await failure(transport().send({ ...message, ...change }));
    expect(error).toMatchObject({ category: 'invalid_message', retryable: false, field, status: undefined });
    expect(requests).toEqual([]);
    expectNothingSensitive(error);
  });
});

describe('ResendTransport: failures are classified, and only safe fields are kept', () => {
  it('times out (retryable) when the provider does not answer', async () => {
    respond = () => undefined; // never answers
    const started = Date.now();
    const error = await failure(transport({ timeoutMs: 200 }).send(message));
    expect(error).toMatchObject({ category: 'timeout', retryable: true, status: undefined });
    expect(Date.now() - started).toBeLessThan(2_000);
    expectNothingSensitive(error);
  });

  it('times out (retryable) when the body of a success never arrives: the outcome is unknown', async () => {
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"id":');
    };
    const error = await failure(transport({ timeoutMs: 300 }).send(message));
    expect(error).toMatchObject({ category: 'timeout', retryable: true, status: 200 });
  });

  it('reports a network error (retryable) when nothing listens, without the underlying message', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));

    const error = await failure(transport({ apiUrl: `http://127.0.0.1:${port}` }).send(message));
    expect(error).toMatchObject({ category: 'network', retryable: true, status: undefined });
    expect(error.message).toBe('email delivery failed: network');
    expectNothingSensitive(error);
  });

  it('treats 429 as retryable and keeps retry-after and the provider code', async () => {
    respond = json(
      429,
      { statusCode: 429, name: 'rate_limit_exceeded', message: 'provider says slow down' },
      { 'retry-after': '2' },
    );
    const error = await failure(transport().send(message));
    expect(error).toMatchObject({
      category: 'rate_limited',
      retryable: true,
      status: 429,
      providerCode: 'rate_limit_exceeded',
      retryAfterSeconds: 2,
    });
    expectNothingSensitive(error);
  });

  it.each([500, 502, 503, 504])('treats %i as a retryable provider error', async (status) => {
    respond = json(status, { name: 'application_error', message: 'provider says oops' });
    const error = await failure(transport().send(message));
    expect(error).toMatchObject({ category: 'provider_error', retryable: true, status });
  });

  it.each([
    [400, 'rejected', 'validation_error'],
    [422, 'rejected', 'missing_required_field'],
    [401, 'unauthorized', 'missing_api_key'],
    [403, 'unauthorized', 'invalid_permission'],
  ])('treats %i as permanent (%s)', async (status, category, name) => {
    // A provider message that echoes the recipient and key must not survive.
    respond = json(status, { statusCode: status, name, message: `provider says ${message.to} ${API_KEY}` });
    const error = await failure(transport().send(message));
    expect(error).toMatchObject({ category, retryable: false, status, providerCode: name });
    expectNothingSensitive(error);
  });

  it('retries a 409 only while the first request with the key is still running', async () => {
    respond = json(409, { name: 'concurrent_idempotent_requests', message: 'provider says wait' });
    expect(await failure(transport().send(message))).toMatchObject({ category: 'conflict', retryable: true });
    respond = json(409, { name: 'invalid_idempotent_request', message: 'provider says body changed' });
    expect(await failure(transport().send(message))).toMatchObject({ category: 'conflict', retryable: false });
  });

  it.each([
    ['404', json(404, { name: 'not_found' }), 'unexpected_response', 404],
    ['418 with no body', (res: ServerResponse) => res.writeHead(418).end(), 'unexpected_response', 418],
  ])('classifies other statuses (%s) as permanent and unexpected', async (_case, handler, category, status) => {
    respond = handler;
    expect(await failure(transport().send(message))).toMatchObject({ category, retryable: false, status });
  });

  it.each([
    ['an HTML page (a wrong RESEND_API_URL)', (res: ServerResponse) => res.writeHead(200).end('<html>hi</html>')],
    ['JSON without an id', json(200, { ok: true })],
    ['an id that is not an id', json(200, { id: `<script>${message.to}</script>` })],
    ['a huge body', json(200, { id: 'x', padding: 'p'.repeat(100_000) })],
  ])('does not count %s as sent', async (_case, handler) => {
    respond = handler;
    const error = await failure(transport().send(message));
    expect(error).toMatchObject({ category: 'unexpected_response', retryable: false, status: 200 });
    expectNothingSensitive(error);
  });

  it('keeps only provider codes that look like codes', async () => {
    for (const name of [`bad ${message.to}`, 'UPPER', 'x'.repeat(65), 42, null]) {
      respond = json(422, { name, message: 'provider says no' });
      const error = await failure(transport().send(message));
      expect(error.providerCode).toBeUndefined();
      expectNothingSensitive(error);
    }
    respond = (res) => res.writeHead(400, { 'content-type': 'application/json' }).end('{not json');
    expect(await failure(transport().send(message))).toMatchObject({ category: 'rejected', providerCode: undefined });
  });

  it('never logs anything itself', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level));
    await transport().send(message);
    respond = json(500, { name: 'application_error', message: 'provider says oops' });
    await failure(transport().send(message));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('parseResendConfig', () => {
  const valid = { RESEND_API_KEY: API_KEY, EMAIL_FROM: 'SmartConnect <no-reply@mail.example.com>' };
  const problemsOf = (env: Record<string, string>, options?: { production?: boolean }) => {
    const problems: string[] = [];
    parseResendConfig(env, problems, options);
    return problems;
  };

  it('reads the key, the sender and safe defaults', () => {
    const problems: string[] = [];
    expect(parseResendConfig(valid, problems)).toEqual({
      apiKey: API_KEY,
      apiUrl: 'https://api.resend.com',
      from: 'SmartConnect <no-reply@mail.example.com>',
      timeoutMs: 10_000,
    });
    expect(problems).toEqual([]);
  });

  it('reads the key from RESEND_API_KEY_FILE, and takes a reply-to, an API URL and a timeout', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'backend-kit-resend-')), 'key');
    writeFileSync(file, `${API_KEY}\n`);
    const problems: string[] = [];
    const config = parseResendConfig(
      {
        RESEND_API_KEY_FILE: file,
        EMAIL_FROM: 'no-reply@mail.example.com',
        EMAIL_REPLY_TO: 'support@example.com',
        RESEND_API_URL: 'http://127.0.0.1:9999/',
        EMAIL_TIMEOUT_MS: '5000',
      },
      problems,
    );
    expect(problems).toEqual([]);
    expect(config).toEqual({
      apiKey: API_KEY,
      apiUrl: 'http://127.0.0.1:9999',
      from: 'no-reply@mail.example.com',
      replyTo: 'support@example.com',
      timeoutMs: 5000,
    });
  });

  it('requires a key and a sender', () => {
    expect(problemsOf({})).toEqual([
      'RESEND_API_KEY (or RESEND_API_KEY_FILE) is required to send email through Resend',
      'EMAIL_FROM is required: an address, or "Name <address>", on a domain verified with Resend',
    ]);
  });

  it('validates every value without ever echoing one', () => {
    const problems = problemsOf({
      RESEND_API_KEY: `${API_KEY} with spaces`,
      EMAIL_FROM: 'Ada <not an address>',
      EMAIL_REPLY_TO: 'nope',
      RESEND_API_URL: `https://user:${API_KEY}@api.resend.com`,
      EMAIL_TIMEOUT_MS: '50',
    });
    expect(problems).toEqual([
      'RESEND_API_KEY must be a single token without spaces or control characters',
      'EMAIL_FROM must be an address, or "Name <address>"',
      'EMAIL_REPLY_TO must be an email address',
      'RESEND_API_URL must be an http(s) URL without credentials, query or fragment',
      'EMAIL_TIMEOUT_MS must be an integer from 1000 to 60000',
    ]);
    expect(problems.join(' ')).not.toContain(API_KEY);
    expect(problemsOf({ ...valid, RESEND_API_KEY_FILE: '/nowhere' })).toEqual([
      'set either RESEND_API_KEY or RESEND_API_KEY_FILE, not both',
    ]);
  });

  it('requires an https API URL in production', () => {
    expect(problemsOf({ ...valid, RESEND_API_URL: 'http://api.resend.com' }, { production: true })).toEqual([
      'RESEND_API_URL must be https in production',
    ]);
    expect(problemsOf({ ...valid, RESEND_API_URL: 'https://api.resend.com' }, { production: true })).toEqual([]);
  });

  it.each(['Ada Lovelace <ada@example.com>', 'ada@example.com', 'SmartConnect Team <no-reply@mail.example.co.uk>'])(
    'accepts the sender %s',
    (from) => expect(problemsOf({ ...valid, EMAIL_FROM: from })).toEqual([]),
  );

  it.each(['Ada', '<ada@example.com>', 'Ada <ada@example.com', 'A\r\nBcc: x <ada@example.com>', 'a@b'])(
    'refuses the sender %j',
    (from) =>
      expect(problemsOf({ ...valid, EMAIL_FROM: from })).toEqual([
        'EMAIL_FROM must be an address, or "Name <address>"',
      ]),
  );
});
