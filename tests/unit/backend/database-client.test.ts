// Unit tests for the services' database access modules (src/database/client.ts).
// No database or Docker: Prisma is replaced by a fake that records what would be sent.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SERVICES, serviceDir } from '../../../infrastructure/scripts/lib/db-lib.mjs';
import * as identity from '../../../smartconnect-backend/services/identity/src/database/client.js';
import * as organization from '../../../smartconnect-backend/services/organization/src/database/client.js';
import * as workspace from '../../../smartconnect-backend/services/workspace/src/database/client.js';

const ORG = '019a4a00-0000-7000-8000-000000000001';
const USER = '019a4a00-0000-7000-8000-0000000a11ce';

const source = (svc: string) => readFileSync(path.join(serviceDir(svc), 'src/database/client.ts'), 'utf8');

/** Replaces the three service-specific tokens so every copy can be compared with one reference. */
const normalise = (svc: string, text: string) =>
  text
    .replace(`for the ${svc} service`, 'for the <svc> service')
    .replace(`sc_${svc}_app`, 'sc_<svc>_app')
    .replace(`DATABASE_SCHEMA = '${svc}'`, "DATABASE_SCHEMA = '<svc>'");

interface RawCall {
  sql: string;
  values: unknown[];
}

/** A stand-in for PrismaClient: runs the interactive-transaction callback and records raw SQL. */
function fakePrisma() {
  const calls: RawCall[] = [];
  const tx = {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join('$?'), values });
      return Promise.resolve(1);
    },
  };
  const $transaction = vi.fn((fn: (client: typeof tx) => Promise<unknown>, _options?: { timeout?: number }) => fn(tx));
  return { prisma: { $transaction } as unknown as workspace.Prisma.DefaultPrismaClient, calls, $transaction };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('one implementation across all services', () => {
  it('every tenant-scoped service ships the same client.ts (modulo its schema name)', () => {
    const reference = normalise('workspace', source('workspace'));
    for (const svc of SERVICES.filter((s: string) => s !== 'identity')) {
      let text = normalise(svc, source(svc));
      if (svc === 'organization') {
        // organization adds withUser() after the shared template
        text = `${text.slice(0, text.indexOf('/**\n * Cross-organization reads')).trimEnd()}\n`;
      }
      expect(text, svc).toBe(reference);
    }
  });

  it('each service targets its own schema', () => {
    for (const svc of SERVICES) expect(source(svc), svc).toContain(`export const DATABASE_SCHEMA = '${svc}';`);
  });

  it('identity data is global: no tenant helper is exported', () => {
    expect(Object.keys(identity)).not.toContain('withTenant');
  });
});

describe('withTenant()', () => {
  it('binds the tenant context as query parameters, transaction-locally — never interpolated into SQL', async () => {
    const { prisma, calls } = fakePrisma();
    await workspace.withTenant(prisma, { organizationId: ORG, userId: USER }, () => Promise.resolve());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("set_config('app.current_organization_id', $?, true)");
    expect(calls[0]!.sql).toContain("set_config('app.current_user_id', $?, true)");
    expect(calls[0]!.sql).not.toContain(ORG);
    expect(calls[0]!.values).toEqual([ORG, USER]);
  });

  it('clears the user context when no user is given', async () => {
    const { prisma, calls } = fakePrisma();
    await workspace.withTenant(prisma, { organizationId: ORG }, () => Promise.resolve());
    expect(calls[0]!.values).toEqual([ORG, '']);
  });

  it('sets the context before running the callback and returns its result', async () => {
    const { prisma, calls } = fakePrisma();
    const result = await workspace.withTenant(prisma, { organizationId: ORG }, () => {
      expect(calls).toHaveLength(1);
      return Promise.resolve('done');
    });
    expect(result).toBe('done');
  });

  it('applies a transaction timeout (10 s by default)', async () => {
    const { prisma, $transaction } = fakePrisma();
    await workspace.withTenant(prisma, { organizationId: ORG }, () => Promise.resolve());
    await workspace.withTenant(prisma, { organizationId: ORG }, () => Promise.resolve(), { timeoutMs: 2_000 });
    expect($transaction.mock.calls.map((call) => call[1])).toEqual([{ timeout: 10_000 }, { timeout: 2_000 }]);
  });

  it.each([
    ['a non-UUID organization id', { organizationId: "x' OR '1'='1" }],
    ['an empty organization id', { organizationId: '' }],
    ['a non-UUID user id', { organizationId: ORG, userId: 'admin' }],
  ])('rejects %s without opening a transaction', async (_label, context) => {
    const { prisma, $transaction } = fakePrisma();
    await expect(workspace.withTenant(prisma, context, () => Promise.resolve())).rejects.toThrow(/must be UUIDs/);
    expect($transaction).not.toHaveBeenCalled();
  });
});

describe('withUser() (organization service)', () => {
  it('sets only the user context, never an organization', async () => {
    const { prisma, calls } = fakePrisma();
    await organization.withUser(prisma as unknown as organization.Prisma.DefaultPrismaClient, USER, () =>
      Promise.resolve(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("set_config('app.current_user_id', $?, true)");
    expect(calls[0]!.sql).not.toContain('app.current_organization_id');
    expect(calls[0]!.values).toEqual([USER]);
  });

  it('rejects a malformed user id without opening a transaction', async () => {
    const { prisma, $transaction } = fakePrisma();
    await expect(
      organization.withUser(prisma as unknown as organization.Prisma.DefaultPrismaClient, 'nope', () =>
        Promise.resolve(),
      ),
    ).rejects.toThrow(/must be a UUID/);
    expect($transaction).not.toHaveBeenCalled();
  });
});

describe('createPrismaClient()', () => {
  it('refuses to start without DATABASE_URL', () => {
    vi.stubEnv('DATABASE_URL', '');
    expect(() => workspace.createPrismaClient()).toThrow('DATABASE_URL is not set');
  });

  it('builds a client lazily, without connecting', async () => {
    const client = workspace.createPrismaClient({ connectionString: 'postgresql://u:p@127.0.0.1:1/none' });
    expect(typeof client.$transaction).toBe('function');
    await client.$disconnect();
  });
});
