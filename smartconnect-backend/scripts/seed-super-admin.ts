// make admin-seed (infrastructure/scripts/admin-seed.sh): creates or resets the DEVELOPMENT Super Admin (ADR 0015).
// The initial password arrives on stdin from the wrapper's hidden prompt: never from argv, the environment or a file,
// and it is never printed.
import { readFileSync } from 'node:fs';
import { createPrismaClient } from '../services/identity/src/database/client.js';
import { assertDevelopmentSeed, seedSuperAdmin, SUPER_ADMIN_EMAIL } from './super-admin.js';

function identityRuntimeUrl(): string {
  const env = readFileSync(new URL('../services/identity/.env', import.meta.url), 'utf8');
  const url = env.match(/^DATABASE_URL=(.+)$/m)?.[1];
  if (!url) throw new Error('identity: no DATABASE_URL — run `make db-bootstrap` first');
  return url;
}

/** The development instance's port, as `make db-*` resolves it (root .env, default 15432). */
function developmentPort(): number {
  let rootEnv = '';
  try {
    rootEnv = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
  } catch {
    // no root .env: the default applies
  }
  return Number(process.env.POSTGRES_PORT ?? rootEnv.match(/^POSTGRES_PORT=(\d+)$/m)?.[1] ?? 15432);
}

async function readPassword(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

const url = identityRuntimeUrl();
assertDevelopmentSeed(process.env, url, developmentPort());
const password = await readPassword();
const db = createPrismaClient({ connectionString: url, maxConnections: 1 });
try {
  const { created } = await seedSuperAdmin(db, password);
  console.log(`✔ ${created ? 'Created' : 'Reset'} the development Super Admin: ${SUPER_ADMIN_EMAIL}`);
  console.log('  Sign in at /admin/login with that address and the password you just typed.');
  console.log('  The first sign-in asks for a new password (at least 12 characters) before anything else.');
  if (!created) console.log('  Its earlier sessions have ended.');
} finally {
  await db.$disconnect();
}
