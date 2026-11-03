// The SMTP transport against a fake ESMTP server on 127.0.0.1: nothing here reaches Gmail or the internet.
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailDeliveryError, type EmailMessage } from '../src/email/delivery.js';
import {
  classifySmtpError,
  parseSmtpConfig,
  SmtpTransport,
  type SmtpConfig,
  type SmtpTestOptions,
} from '../src/email/smtp-transport.js';
import { decodeQuotedPrintable, FakeSmtpServer, type SmtpScript } from './support/fake-smtp.js';

const PASSWORD = 'abcdwxyzabcdwxyz';
const USER = 'smartconnect.mailer@example.com';
const TOKEN = 'Zq3x-raw-one-time-token_abcdefghijklmnopqrstu';
const message: EmailMessage = {
  to: 'ada.lovelace@example.com',
  subject: 'Verify your email address',
  html: `<p>Hello Ada</p><a href="https://app.example.com/verify-email#token=${TOKEN}">Verify</a>`,
  text: `Hello Ada. Verify: https://app.example.com/verify-email#token=${TOKEN}`,
  idempotencyKey: 'email_verification:3f6b1c0e9d8a7b6c5d4e3f2a1b0c9d8e',
};
/** What must never appear in an error or a log line. */
const SECRETS = [PASSWORD, USER, message.to, 'ada.lovelace', TOKEN, message.subject, 'Hello Ada', 'fake.test'];
const PLAIN: SmtpTestOptions = { requireTLS: false, ignoreTLS: true };

const server = new FakeSmtpServer();
const transports: SmtpTransport[] = [];
beforeAll(async () => {
  await server.start();
});
afterAll(() => server.stop());
beforeEach(() => server.reset());
afterEach(() => {
  for (const transport of transports.splice(0)) transport.close();
});

const configFor = (port: number, overrides: Partial<SmtpConfig> = {}): SmtpConfig => ({
  host: '127.0.0.1',
  port,
  secure: false,
  user: USER,
  password: PASSWORD,
  from: 'SmartConnect <smartconnect.mailer@example.com>',
  timeoutMs: 2000,
  ...overrides,
});
function transport(options: SmtpTestOptions | undefined = PLAIN, overrides: Partial<SmtpConfig> = {}) {
  const t = new SmtpTransport(configFor(server.port, overrides), options);
  transports.push(t);
  return t;
}
async function failure(run: Promise<unknown>): Promise<EmailDeliveryError> {
  const error: unknown = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(EmailDeliveryError);
  return error as EmailDeliveryError;
}
const sendWith = async (script: SmtpScript) => {
  server.reset(script);
  return failure(transport().send(message));
};
const closedPort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

describe('SmtpTransport delivery', () => {
  it('sends one message with From, To, Subject, and HTML and text parts', async () => {
    const result = await transport().send(message);
    expect(result.id).toMatch(/^<[^>]+@example\.com>$/);
    expect(server.received.authAttempts).toEqual([{ user: USER, pass: PASSWORD }]);
    expect(server.received.envelope).toEqual({ from: USER, to: [message.to] });
    const data = server.received.data;
    expect(data).toMatch(/^From: SmartConnect <smartconnect\.mailer@example\.com>$/im);
    expect(data).toMatch(/^To: ada\.lovelace@example\.com$/im);
    expect(data).toMatch(/^Subject: Verify your email address$/im);
    expect(data).toMatch(/Content-Type: text\/plain/i);
    expect(data).toMatch(/Content-Type: text\/html/i);
    const body = decodeQuotedPrintable(data);
    expect(body).toContain(message.html);
    expect(body).toContain(message.text);
  });

  it('adds Reply-To when configured', async () => {
    await transport(PLAIN, { replyTo: 'support@example.com' }).send(message);
    expect(server.received.data).toMatch(/^Reply-To: support@example\.com$/im);
  });

  it('refuses an invalid message before connecting', async () => {
    const t = transport();
    for (const bad of [
      { ...message, subject: 'Hi\r\nBcc: evil@example.com' },
      { ...message, to: 'a@example.com, b@example.com' },
      { ...message, html: '' },
    ]) {
      const error = await failure(t.send(bad));
      expect(error).toMatchObject({ category: 'invalid_message', retryable: false });
    }
    expect(server.received.commands).toEqual([]);
  });

  it('maps a refused login (535) to unauthorized, not retryable', async () => {
    const error = await sendWith({ auth: '535 5.7.8 Username and Password not accepted' });
    expect(error).toMatchObject({ category: 'unauthorized', retryable: false, providerCode: 'EAUTH' });
    expect(server.received.commands).not.toContain('MAIL');
  });

  it('maps 451 at RCPT to provider_error, retryable', async () => {
    const error = await sendWith({ rcptTo: '451 4.3.0 try again later' });
    expect(error).toMatchObject({ category: 'provider_error', retryable: true, status: 451 });
  });

  it('maps 550 at RCPT to rejected, not retryable', async () => {
    const error = await sendWith({ rcptTo: '550 5.1.1 no such user' });
    expect(error).toMatchObject({ category: 'rejected', retryable: false, status: 550 });
  });

  it('maps 554 after DATA to unexpected_response, not retryable (no duplicate mail)', async () => {
    const error = await sendWith({ end: '554 5.7.1 message refused' });
    expect(error).toMatchObject({ category: 'unexpected_response', retryable: false, status: 554 });
    expect(server.received.messages).toBe(1);
  });

  it('maps a failure of the DATA command itself to unexpected_response, not retryable', async () => {
    const error = await sendWith({ data: '451 4.3.0 try later' });
    expect(error).toMatchObject({ category: 'unexpected_response', retryable: false, status: 451 });
  });

  it('maps a refused connection to network, retryable', async () => {
    const t = new SmtpTransport(configFor(await closedPort()), PLAIN);
    transports.push(t);
    const error = await failure(t.send(message));
    expect(error).toMatchObject({ category: 'network', retryable: true });
  });

  it('maps a server that never greets to timeout, retryable', async () => {
    server.reset({ greeting: null });
    const error = await failure(transport(PLAIN, { timeoutMs: 300 }).send(message));
    expect(error).toMatchObject({ category: 'timeout', retryable: true });
  });

  it('requires STARTTLS: against a server without it nothing is authenticated or sent', async () => {
    const error = await failure(transport({}).send(message));
    expect(error.retryable).toBe(true);
    expect(server.received.authAttempts).toEqual([]);
    expect(server.received.commands).not.toContain('MAIL');
    expect(server.received.data).toBe('');
  });

  it('verify() succeeds with good credentials without sending', async () => {
    await expect(transport().verify()).resolves.toBeUndefined();
    expect(server.received.authAttempts).toHaveLength(1);
    expect(server.received.messages).toBe(0);
  });

  it('verify() rejects with EmailDeliveryError when authentication fails', async () => {
    server.reset({ auth: '535 5.7.8 nope' });
    const error = await failure(transport().verify());
    expect(error).toMatchObject({ category: 'unauthorized', retryable: false });
  });
});

describe('SmtpTransport never leaks', () => {
  const scripts: SmtpScript[] = [
    { auth: `535 5.7.8 ${USER} ${PASSWORD} rejected` },
    { rcptTo: `451 4.3.0 ${message.to} try later` },
    { rcptTo: `550 5.1.1 <${message.to}> unknown` },
    { end: `554 5.7.1 ${message.subject} refused: Hello Ada ${TOKEN}` },
    { greeting: '554 fake.test no service for ada.lovelace@example.com' },
  ];

  it('keeps secrets out of every rendering of every error, and logs nothing', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const writes = vi.spyOn(process.stdout, 'write');
    const errors: EmailDeliveryError[] = [];
    for (const script of scripts) errors.push(await sendWith(script));
    const refused = new SmtpTransport(configFor(await closedPort()), PLAIN);
    transports.push(refused);
    errors.push(await failure(refused.send(message)));

    expect(errors).toHaveLength(scripts.length + 1);
    for (const error of errors) {
      const rendered = [
        error.message,
        String(error),
        JSON.stringify(error),
        inspect(error, { depth: 10, showHidden: true }),
        error.stack ?? '',
      ].join('\n');
      for (const secret of SECRETS) expect(rendered).not.toContain(secret);
      expect(error.cause).toBeUndefined();
      if (error.providerCode !== undefined) expect(error.providerCode).toMatch(/^[A-Z]{2,20}$/);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  });

  it('classifies by code, reply code and command only, never by message text', () => {
    const hostile = Object.assign(new Error(`${PASSWORD} ${message.to}`), {
      code: 'not a code!',
      response: `550 ${message.to}`,
      command: 'RCPT TO',
    });
    const error = classifySmtpError(hostile);
    expect(error).toMatchObject({ category: 'unexpected_response', retryable: false, providerCode: undefined });
    expect(JSON.stringify(error)).not.toContain(PASSWORD);
    expect(classifySmtpError('boom')).toMatchObject({ category: 'unexpected_response' });
    expect(classifySmtpError(Object.assign(new Error('x'), { code: 'EENVELOPE' }))).toMatchObject({
      category: 'invalid_message',
      retryable: false,
    });
    expect(classifySmtpError(Object.assign(new Error('x'), { code: 'EAUTH', responseCode: 454 }))).toMatchObject({
      category: 'unauthorized',
    });
    expect(
      classifySmtpError(Object.assign(new Error('x'), { code: 'ETIMEDOUT', timeoutType: 'SOCKET_TIMEOUT' })),
    ).toMatchObject({ category: 'unexpected_response', retryable: false });
    expect(classifySmtpError(Object.assign(new Error('x'), { code: 'ESOCKET', command: 'EHLO' }))).toMatchObject({
      category: 'network',
      retryable: true,
    });
  });
});

describe('parseSmtpConfig', () => {
  const base = {
    SMTP_HOST: 'smtp.gmail.com',
    SMTP_USER: USER,
    SMTP_PASSWORD: 'abcd efgh ijkl mnop',
    SMTP_FROM: 'SmartConnect <smartconnect.mailer@example.com>',
  };
  const parse = (env: Record<string, string>, production = false) => {
    const problems: string[] = [];
    const config = parseSmtpConfig(env, problems, { production });
    return { config, problems };
  };

  it('has defaults: port 587, STARTTLS, 15 s', () => {
    const { config, problems } = parse(base);
    expect(problems).toEqual([]);
    expect(config).toEqual({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      user: USER,
      password: 'abcdefghijklmnop',
      from: base.SMTP_FROM,
      timeoutMs: 15_000,
    });
  });

  it('reads every option', () => {
    const { config, problems } = parse(
      { ...base, SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_REPLY_TO: 'help@example.com', SMTP_TIMEOUT_MS: '5000' },
      true,
    );
    expect(problems).toEqual([]);
    expect(config).toMatchObject({ port: 465, secure: true, replyTo: 'help@example.com', timeoutMs: 5000 });
  });

  it('reads the password from a file and strips whitespace', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'smtp-config-')), 'password');
    writeFileSync(file, 'abcd efgh\tijkl mnop\n');
    const { SMTP_PASSWORD: _unused, ...rest } = base;
    const { config, problems } = parse({ ...rest, SMTP_PASSWORD_FILE: file });
    expect(problems).toEqual([]);
    expect(config.password).toBe('abcdefghijklmnop');
  });

  it('requires host, user, password and sender, naming the variables', () => {
    expect(parse({}).problems).toEqual([
      'SMTP_HOST is required to send email through SMTP',
      'SMTP_USER is required to send email through SMTP',
      'SMTP_PASSWORD (or SMTP_PASSWORD_FILE) is required to send email through SMTP',
      'SMTP_FROM is required: an address, or "Name <address>"',
    ]);
  });

  it('rejects bad values without echoing them, the password least of all', () => {
    const secret = 'sup3r secret pw';
    const { problems } = parse({
      SMTP_HOST: 'bad host/with spaces',
      SMTP_PORT: '70000',
      SMTP_SECURE: 'yes-please',
      SMTP_USER: 'u\nser',
      SMTP_PASSWORD: secret,
      SMTP_PASSWORD_FILE: '/nonexistent/' + secret,
      SMTP_FROM: 'not an address',
      SMTP_REPLY_TO: 'nope',
      SMTP_TIMEOUT_MS: '5',
    });
    expect(problems).toEqual([
      'SMTP_HOST must be a host name or IP address',
      'SMTP_PORT must be an integer from 1 to 65535',
      'SMTP_SECURE must be "true" or "false"',
      'SMTP_USER must not contain control characters',
      'set either SMTP_PASSWORD or SMTP_PASSWORD_FILE, not both',
      'SMTP_FROM must be an address, or "Name <address>"',
      'SMTP_REPLY_TO must be an email address',
      'SMTP_TIMEOUT_MS must be an integer from 1000 to 60000',
    ]);
    const joined = problems.join('\n');
    for (const needle of [secret, 'secret', 'not an address', 'bad host', 'yes-please', '70000'])
      expect(joined).not.toContain(needle);
  });

  it('never puts the password in a problem, whatever else is wrong', () => {
    const missingFile = parse({
      ...base,
      SMTP_PASSWORD: undefined as unknown as string,
      SMTP_PASSWORD_FILE: '/no/such',
    });
    expect(missingFile.problems).toEqual(['SMTP_PASSWORD_FILE could not be read (check the path and permissions)']);
    const { problems } = parse({ ...base, SMTP_PORT: 'x', SMTP_PASSWORD: 'hunter2 hunter2' });
    expect(problems.join('\n')).not.toContain('hunter2');
  });

  it('refuses a blank password', () => {
    expect(parse({ ...base, SMTP_PASSWORD: '   ' }).problems).toEqual([
      'SMTP_PASSWORD (or SMTP_PASSWORD_FILE) is required to send email through SMTP',
    ]);
  });
});
