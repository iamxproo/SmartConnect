import { createHash, randomBytes } from 'node:crypto';

/** 256-bit opaque tokens (refresh tokens, password-reset tokens) in base64url: exactly 43 characters. */
export const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Only this digest is ever stored (sessions.refresh_token_hash, verification_tokens.token_hash). A plain SHA-256 is
 * sufficient for 256-bit random tokens: unlike passwords, they cannot be guessed, so no slow hash is needed.
 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The users.email_normalized lookup key: lower(trim(email)), as the column's CHECK constraint requires. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
