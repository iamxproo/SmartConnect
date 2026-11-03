import { AccessTokenVerifier, ACCESS_TOKEN_TYPE } from '@smartconnect/backend-kit';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { describe, expect, it } from 'vitest';
import { AccessTokenIssuer } from '../src/auth/access-token-issuer.js';
import { generateSigningKey } from './keys.js';

const USER = '019a4a00-0000-7000-8000-0000000a11ce';
const SESSION = '019a4a00-0000-7000-8000-000000005e55';
const settings = { issuer: 'smartconnect-identity', audience: 'smartconnect-api', ttlSeconds: 900 };

describe('AccessTokenIssuer', () => {
  const key = generateSigningKey('k-2026-11');
  const issuer = new AccessTokenIssuer(key, settings);

  it('signs an EdDSA at+jwt with identifiers only', async () => {
    const now = new Date('2026-11-03T10:00:00Z');
    const { token, expiresAt } = await issuer.issue(USER, SESSION, now);
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'EdDSA', typ: ACCESS_TOKEN_TYPE, kid: 'k-2026-11' });
    const claims = decodeJwt(token);
    expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'sid', 'sub']);
    expect(claims).toMatchObject({ sub: USER, sid: SESSION, iss: settings.issuer, aud: settings.audience });
    expect(claims.exp! - claims.iat!).toBe(900);
    expect(expiresAt.toISOString()).toBe('2026-11-03T10:15:00.000Z');
  });

  it('verifies with the shared verifier using only the published public key', async () => {
    const jwks = issuer.publicJwks();
    expect(jwks.keys[0]).not.toHaveProperty('d');
    const verifier = new AccessTokenVerifier(jwks, settings);
    const { token } = await issuer.issue(USER, SESSION);
    await expect(verifier.verify(token)).resolves.toMatchObject({ userId: USER, sessionId: SESSION });
  });

  it('is rejected by a verifier that trusts a different key', async () => {
    const other = new AccessTokenIssuer(generateSigningKey('k-2026-11'), settings);
    const verifier = new AccessTokenVerifier(other.publicJwks(), settings);
    const { token } = await issuer.issue(USER, SESSION);
    await expect(verifier.verify(token)).rejects.toMatchObject({ reason: 'invalid' });
  });

  it("expires after its lifetime (beyond the verifier's 5 s clock tolerance)", async () => {
    const verifier = new AccessTokenVerifier(issuer.publicJwks(), settings);
    const { token } = await issuer.issue(USER, SESSION, new Date(Date.now() - 910_000));
    await expect(verifier.verify(token)).rejects.toMatchObject({ reason: 'expired' });
  });
});
