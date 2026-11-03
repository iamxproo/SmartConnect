import { describe, expect, it } from 'vitest';
import { PASSWORD_HASH_PARAMS, PasswordHasher } from '../src/crypto/password-hasher.js';

const hasher = new PasswordHasher();

describe('PasswordHasher (Argon2id)', () => {
  it('produces an Argon2id PHC string with the configured parameters and a random salt', async () => {
    const [first, second] = await Promise.all([
      hasher.hash('correct horse battery'),
      hasher.hash('correct horse battery'),
    ]);
    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain('correct horse battery');
  });

  it('verifies the right password and rejects any other', async () => {
    const stored = await hasher.hash('correct horse battery');
    expect(await hasher.verify(stored, 'correct horse battery')).toBe(true);
    expect(await hasher.verify(stored, 'correct horse batter')).toBe(false);
    expect(await hasher.verify(stored, 'Correct horse battery')).toBe(false);
  });

  it('normalises Unicode (NFKC) so equivalent spellings match', async () => {
    const stored = await hasher.hash('café crème brûlée');
    expect(await hasher.verify(stored, 'café crème brûlée')).toBe(true);
  });

  it('runs a full verification even without a stored hash, and always fails', async () => {
    const started = performance.now();
    expect(await hasher.verify(undefined, 'anything')).toBe(false);
    // Comparable cost to a real verification (the dummy hash uses the same parameters).
    expect(performance.now() - started).toBeGreaterThan(5);
  });

  it('treats a malformed stored hash as a failed verification, not an error', async () => {
    expect(await hasher.verify('not-a-hash', 'anything')).toBe(false);
  });

  it('flags hashes with outdated parameters for an upgrade', async () => {
    const weak = new PasswordHasher({ ...PASSWORD_HASH_PARAMS, memoryCost: 8192, timeCost: 1 });
    const outdated = await weak.hash('correct horse battery');
    expect(hasher.needsRehash(outdated)).toBe(true);
    expect(hasher.needsRehash(await hasher.hash('correct horse battery'))).toBe(false);
    expect(hasher.needsRehash('garbage')).toBe(true);
  });
});
