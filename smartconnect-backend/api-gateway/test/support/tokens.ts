// Test-only signing keys and access tokens. Keys are generated per test run in memory; nothing is written to disk.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { DEFAULT_ACCESS_TOKEN_AUDIENCE, DEFAULT_ACCESS_TOKEN_ISSUER } from '@smartconnect/backend-kit';
import { importJWK, SignJWT, type JWK } from 'jose';

export interface TestKeyPair {
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
}

export function generateTestKeyPair(kid = `test-${randomUUID()}`): TestKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    kid,
    privateJwk: { ...(privateKey.export({ format: 'jwk' }) as JWK), kid, alg: 'EdDSA' },
    publicJwk: { ...(publicKey.export({ format: 'jwk' }) as JWK), kid, alg: 'EdDSA', use: 'sig' },
  };
}

/** The key pair the test gateway trusts. */
export const trustedKeys = generateTestKeyPair();
export const trustedJwks = JSON.stringify({ keys: [trustedKeys.publicJwk] });

export const TEST_USER_ID = '019a4a00-0000-7000-8000-0000000a11ce';
export const TEST_SESSION_ID = '019a4a00-0000-7000-8000-000000005e55';

export interface TokenOptions {
  keys?: TestKeyPair;
  sub?: string;
  sid?: string;
  typ?: string;
  alg?: string;
  issuer?: string;
  audience?: string;
  /** Seconds relative to now. */
  expiresIn?: number;
  issuedAt?: number;
}

export async function signAccessToken(options: TokenOptions = {}): Promise<string> {
  const keys = options.keys ?? trustedKeys;
  const now = Math.floor(Date.now() / 1000);
  const key = await importJWK(keys.privateJwk, 'EdDSA');
  return new SignJWT({ sid: options.sid ?? TEST_SESSION_ID })
    .setProtectedHeader({ alg: options.alg ?? 'EdDSA', kid: keys.kid, typ: options.typ ?? 'at+jwt' })
    .setSubject(options.sub ?? TEST_USER_ID)
    .setIssuer(options.issuer ?? DEFAULT_ACCESS_TOKEN_ISSUER)
    .setAudience(options.audience ?? DEFAULT_ACCESS_TOKEN_AUDIENCE)
    .setJti(randomUUID())
    .setIssuedAt(options.issuedAt ?? now)
    .setExpirationTime(now + (options.expiresIn ?? 900))
    .sign(key);
}

/** An unsigned ("alg":"none") token with otherwise valid claims. */
export function unsignedToken(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: 'none', typ: 'at+jwt' })}.${encode({
    sub: TEST_USER_ID,
    sid: TEST_SESSION_ID,
    jti: randomUUID(),
    iss: DEFAULT_ACCESS_TOKEN_ISSUER,
    aud: DEFAULT_ACCESS_TOKEN_AUDIENCE,
    iat: now,
    exp: now + 900,
  })}.`;
}
