// Test-only Ed25519 signing keys, generated in memory per run.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { JWK } from 'jose';

export function generateSigningKey(kid = `test-${randomUUID()}`): JWK & { kid: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { ...(privateKey.export({ format: 'jwk' }) as JWK), kid };
}
