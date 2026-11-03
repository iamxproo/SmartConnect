import { describe, expect, it } from 'vitest';
import { generateOpaqueToken, normalizeEmail, OPAQUE_TOKEN, sha256Hex } from '../src/crypto/tokens.js';

describe('opaque tokens', () => {
  it('are 256-bit base64url strings, unique per call', () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateOpaqueToken));
    expect(tokens.size).toBe(1000);
    for (const token of tokens) expect(token).toMatch(OPAQUE_TOKEN);
  });

  it('are stored only as a 64-character SHA-256 hex digest (fits sessions.refresh_token_hash CHAR(64))', () => {
    const token = generateOpaqueToken();
    const digest = sha256Hex(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(token);
    expect(sha256Hex(token)).toBe(digest);
  });
});

describe('normalizeEmail', () => {
  it('trims and lower-cases (users.email_normalized CHECK constraint)', () => {
    expect(normalizeEmail('  Ada.Lovelace@Example.COM ')).toBe('ada.lovelace@example.com');
  });
});
