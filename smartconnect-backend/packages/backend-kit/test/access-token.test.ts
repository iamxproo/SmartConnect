import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { importJWK, SignJWT, type JWK } from 'jose';
import { describe, expect, it } from 'vitest';
import { AccessTokenVerifier, parsePublicJwks } from '../src/auth/access-token.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const kid = 'kit-test';
const problems: string[] = [];
const jwks = parsePublicJwks(
  'JWKS',
  JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid }] }),
  problems,
)!;
const settings = { issuer: 'iss', audience: 'aud' };
const verifier = new AccessTokenVerifier(jwks, settings);
const USER = '019a4a00-0000-7000-8000-0000000a11ce';
const SESSION = '019a4a00-0000-7000-8000-000000005e55';

async function sign(claims: Record<string, unknown>, omit: string[] = []): Promise<string> {
  const key = await importJWK({ ...(privateKey.export({ format: 'jwk' }) as JWK) }, 'EdDSA');
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    sid: SESSION,
    sub: USER,
    jti: randomUUID(),
    iss: 'iss',
    aud: 'aud',
    iat: now,
    exp: now + 900,
    ...claims,
  };
  for (const name of omit) delete payload[name];
  return new SignJWT(payload).setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid }).sign(key);
}

describe('AccessTokenVerifier', () => {
  it('returns the principal for a valid token', async () => {
    expect(problems).toEqual([]);
    await expect(verifier.verify(await sign({}))).resolves.toMatchObject({ userId: USER, sessionId: SESSION });
  });

  it.each([['sid'], ['jti'], ['sub'], ['exp'], ['iat']])('rejects a token without %s', async (claim) => {
    await expect(verifier.verify(await sign({}, [claim]))).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('rejects non-UUID subject or session ids', async () => {
    await expect(verifier.verify(await sign({ sid: 'session-1' }))).rejects.toMatchObject({ reason: 'invalid' });
    await expect(verifier.verify(await sign({ sub: 'root' }))).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('rejects oversized input without parsing it', async () => {
    await expect(verifier.verify('a'.repeat(5000))).rejects.toMatchObject({ reason: 'invalid' });
  });
});
