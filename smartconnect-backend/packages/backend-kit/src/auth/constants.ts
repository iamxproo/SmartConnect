// The token contract between the identity service (issuer) and its verifiers (gateway, services). ADR 0009.

export const DEFAULT_ACCESS_TOKEN_ISSUER = 'smartconnect-identity';
export const DEFAULT_ACCESS_TOKEN_AUDIENCE = 'smartconnect-api';

/**
 * Web refresh-token cookie (docs/api/conventions.md#authentication-and-sessions). The `__Secure-` prefix makes
 * browsers refuse it unless it is `Secure`; the path keeps it off every request except /api/v1/auth/*.
 */
export const REFRESH_TOKEN_COOKIE = '__Secure-sc_refresh';
export const REFRESH_TOKEN_COOKIE_PATH = '/api/v1/auth';
