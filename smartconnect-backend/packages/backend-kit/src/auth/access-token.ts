// Access-token verification shared by the gateway and services (ADR 0009). The identity service is the only
// issuer and the only holder of the private key; everyone else verifies with the public JWKS.
import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet, type JWK } from 'jose';

/** Ed25519 signatures (JWS "EdDSA"). No other algorithm is ever accepted, which rules out alg confusion. */
export const ACCESS_TOKEN_ALG = 'EdDSA';
/** RFC 9068 media type, so an access token cannot be confused with any other JWT the platform might issue. */
export const ACCESS_TOKEN_TYPE = 'at+jwt';

const MAX_TOKEN_LENGTH = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AccessTokenSettings {
  issuer: string;
  audience: string;
}

/** The authenticated caller, derived only from a verified access token (never from request headers or bodies). */
export interface Principal {
  userId: string;
  sessionId: string;
  tokenId: string;
  expiresAt: Date;
}

export class AccessTokenError extends Error {
  constructor(readonly reason: 'expired' | 'invalid') {
    super(`access token ${reason}`);
    this.name = 'AccessTokenError';
  }
}

/**
 * Parses and validates a JSON Web Key Set of Ed25519 **public** keys. Keys must carry a unique `kid` (rotation:
 * publish the new key, start signing with it, drop the old key after the access-token lifetime). Private key
 * material is rejected, so a misplaced private key cannot end up in a verifier's configuration.
 */
export function parsePublicJwks(name: string, raw: string, problems: string[]): JSONWebKeySet | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    problems.push(`${name} must be a JSON Web Key Set: {"keys":[…]}`);
    return undefined;
  }
  const keys = (parsed as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    problems.push(`${name} must contain at least one key`);
    return undefined;
  }
  const result: JWK[] = [];
  const kids = new Set<string>();
  for (const [index, key] of keys.entries()) {
    const jwk = key as Record<string, unknown>;
    const where = `${name} key ${index}`;
    if (typeof jwk !== 'object' || jwk === null) {
      problems.push(`${where} is not an object`);
      continue;
    }
    if ('d' in jwk) problems.push(`${where} contains private key material; publish only public keys`);
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string')
      problems.push(`${where} must be an Ed25519 public key (kty "OKP", crv "Ed25519", x)`);
    if (typeof jwk.kid !== 'string' || !jwk.kid) problems.push(`${where} needs a non-empty "kid"`);
    else if (kids.has(jwk.kid)) problems.push(`${where} repeats kid "${jwk.kid}"`);
    else kids.add(jwk.kid);
    if (jwk.alg !== undefined && jwk.alg !== ACCESS_TOKEN_ALG) problems.push(`${where} alg must be "EdDSA"`);
    if (jwk.use !== undefined && jwk.use !== 'sig') problems.push(`${where} use must be "sig"`);
    result.push({
      kty: 'OKP',
      crv: 'Ed25519',
      x: jwk.x as string,
      kid: jwk.kid as string,
      alg: ACCESS_TOKEN_ALG,
      use: 'sig',
    });
  }
  return { keys: result };
}

export class AccessTokenVerifier {
  private readonly keySet: ReturnType<typeof createLocalJWKSet>;

  constructor(
    jwks: JSONWebKeySet,
    private readonly settings: AccessTokenSettings & { clockToleranceSeconds?: number },
  ) {
    this.keySet = createLocalJWKSet(jwks);
  }

  /** Resolves the principal or throws AccessTokenError ("expired" only for tokens whose signature is valid). */
  async verify(token: string): Promise<Principal> {
    if (token.length > MAX_TOKEN_LENGTH) throw new AccessTokenError('invalid');
    try {
      const { payload } = await jwtVerify(token, this.keySet, {
        algorithms: [ACCESS_TOKEN_ALG],
        typ: ACCESS_TOKEN_TYPE,
        issuer: this.settings.issuer,
        audience: this.settings.audience,
        clockTolerance: this.settings.clockToleranceSeconds ?? 5,
        requiredClaims: ['sub', 'sid', 'jti', 'iat', 'exp'],
      });
      const { sub, sid, jti, exp } = payload;
      if (
        typeof sub !== 'string' ||
        typeof sid !== 'string' ||
        typeof jti !== 'string' ||
        typeof exp !== 'number' ||
        !UUID.test(sub) ||
        !UUID.test(sid)
      ) {
        throw new AccessTokenError('invalid');
      }
      return { userId: sub, sessionId: sid, tokenId: jti, expiresAt: new Date(exp * 1000) };
    } catch (error) {
      if (error instanceof AccessTokenError) throw error;
      // jose checks the signature before the claims, so "expired" is only reported for genuine tokens.
      if (error instanceof errors.JWTExpired) throw new AccessTokenError('expired');
      throw new AccessTokenError('invalid');
    }
  }
}
