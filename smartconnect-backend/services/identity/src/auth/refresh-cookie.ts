// The web client's refresh token travels only in this cookie (docs/api/conventions.md#authentication-and-sessions):
// HttpOnly (no script access), Secure, SameSite=Strict, and scoped to /api/v1/auth. The gateway additionally
// requires an allowed Origin on every state-changing request that carries cookies.
import { REFRESH_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE_PATH } from '@smartconnect/backend-kit';

const ATTRIBUTES = `Path=${REFRESH_TOKEN_COOKIE_PATH}; HttpOnly; Secure; SameSite=Strict`;

export function refreshCookie(token: string, maxAgeSeconds: number): string {
  return `${REFRESH_TOKEN_COOKIE}=${token}; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; ${ATTRIBUTES}`;
}

export function clearedRefreshCookie(): string {
  return `${REFRESH_TOKEN_COOKIE}=; Max-Age=0; ${ATTRIBUTES}`;
}

/** The refresh token from a Cookie header, if present. */
export function readRefreshCookie(header: string | undefined): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator).trim() === REFRESH_TOKEN_COOKIE) {
      return part.slice(separator + 1).trim() || undefined;
    }
  }
  return undefined;
}
