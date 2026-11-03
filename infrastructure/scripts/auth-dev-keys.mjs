#!/usr/bin/env node
// Generates a LOCAL DEVELOPMENT access-token signing key pair (Ed25519, ADR 0009):
//   .secrets/auth/identity-jwt-private.jwk.json   private key: identity service only (AUTH_JWT_PRIVATE_JWK_FILE)
//   .secrets/auth/jwt-public.jwks.json            public JWKS: gateway and verifiers (AUTH_JWT_PUBLIC_JWKS_FILE)
// .secrets/ is gitignored; files are written owner-only (0600) in an owner-only directory, and key material is never
// printed. Refuses to replace existing keys unless --force (replacing them invalidates every issued access token).
// Production keys come from the secrets manager, never from this script.
//
//   make auth-dev-keys [FORCE=1]
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './lib/db-lib.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const outIndex = args.indexOf('--out');
const dir = outIndex >= 0 ? path.resolve(args[outIndex + 1] ?? '') : path.join(REPO_ROOT, '.secrets', 'auth');
const privateFile = path.join(dir, 'identity-jwt-private.jwk.json');
const publicFile = path.join(dir, 'jwt-public.jwks.json');

if (!force && (existsSync(privateFile) || existsSync(publicFile))) {
  console.log(`Keys already exist in ${path.relative(REPO_ROOT, dir) || dir} (kept). Use FORCE=1 to replace them.`);
  process.exit(0);
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const kid = `dev-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
const privateJwk = { ...privateKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' };
const publicJwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' }] };

mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
/** Exclusive-create a temp file with 0600, then rename over the target (never follows a planted symlink). */
function writeSecret(file, content) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, file);
}
writeSecret(privateFile, privateJwk);
writeSecret(publicFile, publicJwks);
console.log(
  `Wrote a new Ed25519 key pair (kid ${kid}) to ${path.relative(REPO_ROOT, dir) || dir}/ (owner-only, gitignored).`,
);
