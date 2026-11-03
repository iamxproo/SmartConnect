import { randomUUID } from 'node:crypto';
import { ACCESS_TOKEN_ALG, ACCESS_TOKEN_TYPE } from '@smartconnect/backend-kit';
import { importJWK, SignJWT, type JSONWebKeySet, type JWK } from 'jose';

export interface IssuedAccessToken {
  token: string;
  expiresAt: Date;
}

/**
 * Signs short-lived access tokens (ADR 0009). The identity service is the only holder of the private key; the
 * gateway and other services verify with the public JWKS. Claims carry identifiers only, never email or roles:
 * `sub` (user), `sid` (session), `jti`, `iat`, `exp`, plus issuer and audience.
 */
export class AccessTokenIssuer {
  private readonly key: ReturnType<typeof importJWK>;

  constructor(
    private readonly privateJwk: JWK & { kid: string },
    private readonly settings: { issuer: string; audience: string; ttlSeconds: number },
  ) {
    this.key = importJWK(privateJwk, ACCESS_TOKEN_ALG);
  }

  get ttlSeconds(): number {
    return this.settings.ttlSeconds;
  }

  async issue(userId: string, sessionId: string, now = new Date()): Promise<IssuedAccessToken> {
    const issuedAt = Math.floor(now.getTime() / 1000);
    const expiresAt = issuedAt + this.settings.ttlSeconds;
    const token = await new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: ACCESS_TOKEN_ALG, typ: ACCESS_TOKEN_TYPE, kid: this.privateJwk.kid })
      .setSubject(userId)
      .setIssuer(this.settings.issuer)
      .setAudience(this.settings.audience)
      .setJti(randomUUID())
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(await this.key);
    return { token, expiresAt: new Date(expiresAt * 1000) };
  }

  /** The public half of the signing key, for this service's own verifier (and for publishing to verifiers). */
  publicJwks(): JSONWebKeySet {
    const { kty, crv, x, kid } = this.privateJwk;
    return { keys: [{ kty, crv, x, kid, alg: ACCESS_TOKEN_ALG, use: 'sig' }] };
  }
}
