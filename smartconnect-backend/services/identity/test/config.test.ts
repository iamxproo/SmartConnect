import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { generateSigningKey } from './keys.js';

const key = generateSigningKey('k1');
const base = {
  DATABASE_URL: 'postgresql://sc_identity_app:pw@127.0.0.1:15433/smartconnect_test?schema=identity',
  AUTH_JWT_PRIVATE_JWK: JSON.stringify(key),
};

function problemsOf(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe('identity loadConfig', () => {
  it('has safe defaults: loopback :3101, trusts one proxy (the gateway), 15 min / 30 d / 90 d / 30 min', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      env: 'development',
      host: '127.0.0.1',
      port: 3101,
      trustProxyHops: 1,
      issuer: 'smartconnect-identity',
      audience: 'smartconnect-api',
      accessTokenTtlSeconds: 900,
      refreshIdleTtlSeconds: 30 * 86400,
      sessionMaxLifetimeSeconds: 90 * 86400,
      passwordResetTtlSeconds: 1800,
      accountNotifier: 'dev-mailbox',
    });
    expect(config.signingKey.kid).toBe('k1');
  });

  it('has no default secrets: the database URL and signing key are required', () => {
    expect(problemsOf({})).toEqual([
      'DATABASE_URL is required (locally: make db-bootstrap writes it to services/identity/.env)',
      'AUTH_JWT_PRIVATE_JWK (or AUTH_JWT_PRIVATE_JWK_FILE) is required; locally: make auth-dev-keys',
    ]);
  });

  it('reads the signing key from a file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'identity-config-'));
    const file = path.join(dir, 'key.jwk.json');
    writeFileSync(file, JSON.stringify(key));
    expect(loadConfig({ DATABASE_URL: base.DATABASE_URL, AUTH_JWT_PRIVATE_JWK_FILE: file }).signingKey.kid).toBe('k1');
  });

  it('accepts only an Ed25519 private key with a kid', () => {
    const { d: _d, ...publicOnly } = key;
    expect(problemsOf({ ...base, AUTH_JWT_PRIVATE_JWK: JSON.stringify(publicOnly) })).toEqual([
      'AUTH_JWT_PRIVATE_JWK must be an Ed25519 private key (kty "OKP", crv "Ed25519", d, x)',
    ]);
    expect(problemsOf({ ...base, AUTH_JWT_PRIVATE_JWK: JSON.stringify({ ...key, kid: '' }) })).toEqual([
      'AUTH_JWT_PRIVATE_JWK needs a non-empty "kid" (verifiers select the key by it)',
    ]);
    expect(problemsOf({ ...base, AUTH_JWT_PRIVATE_JWK: 'secret' })).toEqual([
      'AUTH_JWT_PRIVATE_JWK must be a JSON Web Key',
    ]);
  });

  it('requires the web app URL (links in emails) in production', () => {
    expect(problemsOf({ ...base, NODE_ENV: 'production', ACCOUNT_NOTIFIER: 'disabled' })).toEqual([
      'WEB_APP_URL is required in production (links in account emails)',
    ]);
    expect(loadConfig(base).webAppUrl).toBe('http://127.0.0.1:5173');
    expect(loadConfig({ ...base, EMAIL_VERIFICATION_TTL_HOURS: '24' }).emailVerificationTtlSeconds).toBe(86_400);
  });

  it('requires an explicit account notifier in production and refuses the dev mailbox there', () => {
    const production = { ...base, NODE_ENV: 'production', WEB_APP_URL: 'https://app.example.com' };
    expect(problemsOf({ ...base, NODE_ENV: 'production', WEB_APP_URL: 'https://app.example.com' })).toEqual([
      'ACCOUNT_NOTIFIER is required in production ("smtp" sends mail; "disabled" drops it)',
      'ACCOUNT_NOTIFIER=dev-mailbox is not allowed in production (it exposes reset tokens over HTTP)',
    ]);
    expect(problemsOf({ ...production, ACCOUNT_NOTIFIER: 'dev-mailbox' })).toEqual([
      'ACCOUNT_NOTIFIER=dev-mailbox is not allowed in production (it exposes reset tokens over HTTP)',
    ]);
    expect(loadConfig({ ...production, ACCOUNT_NOTIFIER: 'disabled' }).accountNotifier).toBe('disabled');
  });

  it('requires an https web app URL in production (links carry one-time tokens)', () => {
    const production = { ...base, NODE_ENV: 'production', ACCOUNT_NOTIFIER: 'disabled' };
    expect(problemsOf({ ...production, WEB_APP_URL: 'http://app.example.com' })).toEqual([
      'WEB_APP_URL must be https in production (links in account emails carry one-time tokens)',
    ]);
    expect(loadConfig({ ...production, WEB_APP_URL: 'https://app.example.com/' }).webAppUrl).toBe(
      'https://app.example.com',
    );
    expect(loadConfig({ ...base, WEB_APP_URL: 'http://localhost:5173' }).webAppUrl).toBe('http://localhost:5173');
  });

  describe('ACCOUNT_NOTIFIER=smtp', () => {
    const smtpEnv = {
      ACCOUNT_NOTIFIER: 'smtp',
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_USER: 'mailer@example.com',
      SMTP_PASSWORD: 'abcd efgh ijkl mnop',
      SMTP_FROM: 'SmartConnect <mailer@example.com>',
    };

    it('reads the SMTP settings (spaces stripped from the app password)', () => {
      const config = loadConfig({ ...base, ...smtpEnv });
      expect(config.accountNotifier).toBe('smtp');
      expect(config.smtp).toMatchObject({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        user: 'mailer@example.com',
        password: 'abcdefghijklmnop',
      });
    });

    it('is allowed in production, but needs the SMTP settings and an https web app URL', () => {
      const production = { ...base, ...smtpEnv, NODE_ENV: 'production', WEB_APP_URL: 'https://app.example.com' };
      expect(loadConfig(production).accountNotifier).toBe('smtp');
      expect(
        problemsOf({
          ...base,
          NODE_ENV: 'production',
          WEB_APP_URL: 'https://app.example.com',
          ACCOUNT_NOTIFIER: 'smtp',
        }),
      ).toEqual([
        'SMTP_HOST is required to send email through SMTP',
        'SMTP_USER is required to send email through SMTP',
        'SMTP_PASSWORD (or SMTP_PASSWORD_FILE) is required to send email through SMTP',
        'SMTP_FROM is required: an address, or "Name <address>"',
      ]);
      expect(problemsOf({ ...production, WEB_APP_URL: 'http://app.example.com' })).toEqual([
        'WEB_APP_URL must be https in production (links in account emails carry one-time tokens)',
      ]);
    });

    it('ignores SMTP variables for other notifiers and never echoes the password', () => {
      expect(loadConfig({ ...base, ...smtpEnv, ACCOUNT_NOTIFIER: 'disabled' }).smtp).toBeUndefined();
      const problems = problemsOf({ ...base, ...smtpEnv, SMTP_PORT: 'x', SMTP_FROM: 'nope' });
      expect(problems).toEqual([
        'SMTP_PORT must be an integer from 1 to 65535',
        'SMTP_FROM must be an address, or "Name <address>"',
      ]);
      expect(problems.join(' ')).not.toContain('abcd');
    });
  });

  it('bounds token lifetimes and keeps the session cap above the idle timeout', () => {
    expect(problemsOf({ ...base, ACCESS_TOKEN_TTL_SECONDS: '86400' })).toEqual([
      'ACCESS_TOKEN_TTL_SECONDS must be an integer from 60 to 3600',
    ]);
    expect(problemsOf({ ...base, REFRESH_TOKEN_IDLE_DAYS: '30', SESSION_MAX_LIFETIME_DAYS: '7' })).toEqual([
      'SESSION_MAX_LIFETIME_DAYS must be at least REFRESH_TOKEN_IDLE_DAYS',
    ]);
  });

  it('never echoes secret values in problems', () => {
    const problems = problemsOf({ DATABASE_URL: 'mysql://user:topsecret@db/x', AUTH_JWT_PRIVATE_JWK: 'topsecret' });
    expect(problems.join(' ')).not.toContain('topsecret');
  });
});
