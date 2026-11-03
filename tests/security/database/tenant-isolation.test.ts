// Multi-tenant isolation, exercised through the services' real Prisma clients and withTenant()
// (src/database/client.ts) on the disposable test instance. Each run uses fresh random tenants.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SERVICES } from '../../../infrastructure/scripts/lib/db-lib.mjs';
import * as administration from '../../../smartconnect-backend/services/administration/src/database/client.js';
import * as messaging from '../../../smartconnect-backend/services/messaging/src/database/client.js';
import * as notifications from '../../../smartconnect-backend/services/notifications/src/database/client.js';
import * as organization from '../../../smartconnect-backend/services/organization/src/database/client.js';
import * as workspace from '../../../smartconnect-backend/services/workspace/src/database/client.js';
import { adminUrl, appUrl, query } from '../../support/database.js';

const A = randomUUID(); // organization A
const B = randomUUID(); // organization B
const U = randomUUID(); // user: member of A and B
const V = randomUUID(); // user: member of A only
const slug = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

const clients = {
  workspace: workspace.createPrismaClient({ connectionString: appUrl('workspace'), maxConnections: 2 }),
  organization: organization.createPrismaClient({ connectionString: appUrl('organization'), maxConnections: 2 }),
  messaging: messaging.createPrismaClient({ connectionString: appUrl('messaging'), maxConnections: 2 }),
  notifications: notifications.createPrismaClient({ connectionString: appUrl('notifications'), maxConnections: 2 }),
  administration: administration.createPrismaClient({ connectionString: appUrl('administration'), maxConnections: 2 }),
};
afterAll(() => Promise.all(Object.values(clients).map((c) => c.$disconnect())));

describe('row-level security coverage (catalog)', () => {
  it('every tenant-scoped table has RLS enabled and at least one policy', async () => {
    const rows = await query(
      adminUrl(),
      `
      select n.nspname || '.' || c.relname as tbl, c.relrowsecurity as rls,
             (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname = any($1) and c.relname <> 'outbox_events'
        and (exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped)
             or (n.nspname, c.relname) = ('organization', 'organizations'))`,
      [SERVICES],
    );
    expect(rows.length).toBeGreaterThanOrEqual(48);
    expect(rows.filter((r) => !r.rls || r.policies < 1)).toEqual([]);
  });

  it('no table in any service schema uses FORCE ROW LEVEL SECURITY or is exempt by a BYPASSRLS runtime role', async () => {
    const forced = await query(
      adminUrl(),
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                                            where c.relforcerowsecurity and n.nspname = any($1)`,
      [SERVICES],
    );
    expect(forced).toEqual([]); // the owner (migrator) is intentionally exempt for migrations and backfills
  });
});

describe('workspace: tenant isolation through Prisma + withTenant()', () => {
  const db = clients.workspace;
  let wA = '';
  let wB = '';

  beforeAll(async () => {
    wA = (
      await workspace.withTenant(db, { organizationId: A }, (tx) =>
        tx.workspace.create({ data: { organizationId: A, name: 'A', slug: slug('a'), createdByUserId: U } }),
      )
    ).id;
    wB = (
      await workspace.withTenant(db, { organizationId: B }, (tx) =>
        tx.workspace.create({ data: { organizationId: B, name: 'B', slug: slug('b'), createdByUserId: U } }),
      )
    ).id;
  });

  it('a tenant sees only its own rows', async () => {
    const seen = await workspace.withTenant(db, { organizationId: A }, (tx) =>
      tx.workspace.findMany({ where: { id: { in: [wA, wB] } } }),
    );
    expect(seen.map((w) => w.id)).toEqual([wA]);
  });

  it('queries without tenant context see nothing (fail closed)', async () => {
    expect(await db.workspace.findMany({ where: { id: { in: [wA, wB] } } })).toEqual([]);
  });

  it('cannot insert a row for another tenant', async () => {
    await expect(
      workspace.withTenant(db, { organizationId: A }, (tx) =>
        tx.workspace.create({ data: { organizationId: B, name: 'x', slug: slug('x'), createdByUserId: U } }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot move its own row to another tenant', async () => {
    await expect(
      workspace.withTenant(db, { organizationId: A }, (tx) =>
        tx.workspace.update({ where: { id: wA }, data: { organizationId: B } }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot update or delete another tenant's rows (they are invisible)", async () => {
    const result = await workspace.withTenant(db, { organizationId: A }, async (tx) => ({
      updated: (await tx.workspace.updateMany({ where: { id: wB }, data: { name: 'pwned' } })).count,
      deleted: (await tx.workspace.deleteMany({ where: { id: wB } })).count,
    }));
    expect(result).toEqual({ updated: 0, deleted: 0 });
  });

  it("composite tenant foreign keys reject a reference to another tenant's parent, even with its id", async () => {
    await expect(
      workspace.withTenant(db, { organizationId: A }, (tx) =>
        tx.channel.create({ data: { organizationId: A, workspaceId: wB, name: 'leak', createdByUserId: U } }),
      ),
    ).rejects.toThrow(/Foreign key constraint/);
  });

  it('tenant context never leaks to the next transaction on a reused pooled connection', async () => {
    const single = workspace.createPrismaClient({ connectionString: appUrl('workspace'), maxConnections: 1 });
    try {
      expect(
        await workspace.withTenant(single, { organizationId: A }, (tx) => tx.workspace.count({ where: { id: wA } })),
      ).toBe(1);
      expect(await single.workspace.count({ where: { id: { in: [wA, wB] } } })).toBe(0);
    } finally {
      await single.$disconnect();
    }
  });

  it('rejects malformed tenant identifiers before touching the database', async () => {
    await expect(
      workspace.withTenant(db, { organizationId: "x' OR '1'='1" }, (tx) => tx.workspace.count()),
    ).rejects.toThrow(/must be UUIDs/);
  });

  it('the transactional outbox commits or rolls back together with the state change', async () => {
    const write = (id: string, fail: boolean) =>
      workspace.withTenant(db, { organizationId: A }, async (tx) => {
        await tx.workspace.create({
          data: { id, organizationId: A, name: 'outbox', slug: slug('o'), createdByUserId: U },
        });
        await tx.outboxEvent.create({
          data: {
            aggregateType: 'workspace',
            aggregateId: id,
            eventType: 'workspace.workspace.created',
            organizationId: A,
            payload: { id },
          },
        });
        if (fail) throw new Error('simulated failure');
      });
    const count = (id: string) =>
      workspace.withTenant(db, { organizationId: A }, async (tx) => [
        await tx.workspace.count({ where: { id } }),
        await tx.outboxEvent.count({ where: { aggregateId: id } }),
      ]);
    const rolledBack = randomUUID();
    await expect(write(rolledBack, true)).rejects.toThrow('simulated failure');
    expect(await count(rolledBack)).toEqual([0, 0]);
    const committed = randomUUID();
    await write(committed, false);
    expect(await count(committed)).toEqual([1, 1]);
  });
});

describe('messaging: cross-tenant references', () => {
  it("a message cannot be attached to another tenant's conversation", async () => {
    const db = clients.messaging;
    const conversationB = await messaging.withTenant(db, { organizationId: B }, (tx) =>
      tx.conversation.create({ data: { organizationId: B, kind: 'group', title: 'B only' } }),
    );
    await expect(
      messaging.withTenant(db, { organizationId: A }, (tx) =>
        tx.message.create({
          data: { organizationId: A, conversationId: conversationB.id, senderUserId: U, body: 'leak' },
        }),
      ),
    ).rejects.toThrow(/Foreign key constraint/);
  });
});

describe('organization: membership-aware policies', () => {
  const db = clients.organization;
  const tokenValid = randomUUID().replace(/-/g, '').padEnd(64, '0');
  const tokenExpired = randomUUID().replace(/-/g, '').padEnd(64, '1');

  beforeAll(async () => {
    for (const [orgId, members] of [
      [A, [U, V]],
      [B, [U]],
    ] as const) {
      await organization.withTenant(db, { organizationId: orgId }, async (tx) => {
        await tx.organization.create({
          data: { id: orgId, slug: slug('org'), name: `Org ${orgId.slice(0, 4)}`, createdByUserId: U },
        });
        const role = await tx.organizationRole.create({
          data: { organizationId: orgId, key: 'member', name: 'Member', permissions: [], isSystem: true },
        });
        for (const userId of members)
          await tx.organizationMember.create({ data: { organizationId: orgId, userId, roleId: role.id } });
        if (orgId === A) {
          const day = 86_400_000;
          await tx.organizationInvitation.createMany({
            data: [
              {
                organizationId: A,
                emailNormalized: 'new@example.com',
                roleId: role.id,
                invitedByUserId: U,
                tokenHash: tokenValid,
                expiresAt: new Date(Date.now() + day),
              },
              {
                organizationId: A,
                emailNormalized: 'late@example.com',
                roleId: role.id,
                invitedByUserId: U,
                tokenHash: tokenExpired,
                expiresAt: new Date(Date.now() - day),
              },
            ],
          });
        }
      });
    }
  });

  it('a user sees every organization they belong to — and only those — without tenant context', async () => {
    const forU = await organization.withUser(db, U, (tx) =>
      tx.organization.findMany({ where: { id: { in: [A, B] } }, orderBy: { id: 'asc' } }),
    );
    const forV = await organization.withUser(db, V, (tx) =>
      tx.organization.findMany({ where: { id: { in: [A, B] } } }),
    );
    expect(forU.map((o) => o.id)).toEqual([A, B].sort());
    expect(forV.map((o) => o.id)).toEqual([A]);
  });

  it("user-scoped reads expose only the user's own memberships, not co-members", async () => {
    const rows = await organization.withUser(db, V, (tx) =>
      tx.organizationMember.findMany({ where: { organizationId: { in: [A, B] } } }),
    );
    expect(rows.map((m) => m.userId)).toEqual([V]);
  });

  it('tenant-scoped reads see all members of that tenant only', async () => {
    const rows = await organization.withTenant(db, { organizationId: A }, (tx) =>
      tx.organizationMember.findMany({ where: { userId: { in: [U, V] } } }),
    );
    expect(rows.map((m) => m.organizationId)).toEqual([A, A]);
  });

  it('a tenant context stays strictly one tenant even when the user belongs to others', async () => {
    // U is a member of A and B. Inside withTenant(A, U), unfiltered reads must not reach B.
    const seen = await organization.withTenant(db, { organizationId: A, userId: U }, async (tx) => ({
      members: [
        ...new Set((await tx.organizationMember.findMany({ where: { userId: U } })).map((m) => m.organizationId)),
      ],
      orgs: (await tx.organization.findMany({ where: { id: { in: [A, B] } } })).map((o) => o.id),
      roles: [
        ...new Set(
          (await tx.organizationRole.findMany({ where: { organizationId: { in: [A, B] } } })).map(
            (r) => r.organizationId,
          ),
        ),
      ],
    }));
    expect(seen).toEqual({ members: [A], orgs: [A], roles: [A] });
  });

  it('user-scoped context cannot write', async () => {
    await expect(
      organization.withUser(db, U, (tx) =>
        tx.organizationRole.create({ data: { organizationId: A, key: 'sneaky', name: 'x', permissions: [] } }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('resolve_invitation_token() resolves only valid tokens and reveals nothing else', async () => {
    const url = appUrl('organization');
    const resolve = (hash: string) => query(url, 'select * from organization.resolve_invitation_token($1)', [hash]);
    const anyId: unknown = expect.any(String);
    expect(await resolve(tokenValid)).toEqual([{ organization_id: A, invitation_id: anyId }]);
    expect(await resolve(tokenExpired)).toEqual([]);
    expect(
      await query(
        url,
        'select count(*)::int as n from organization.organization_invitations where token_hash = any($1)',
        [[tokenValid, tokenExpired]],
      ),
    ).toEqual([{ n: 0 }]);
  });
});

describe('notifications: cross-tenant work claiming', () => {
  it('workers claim due deliveries of every tenant only through claim_notification_deliveries()', async () => {
    const db = clients.notifications;
    const deliveryIds: Record<string, string> = {};
    for (const orgId of [A, B]) {
      const n = await notifications.withTenant(db, { organizationId: orgId }, (tx) =>
        tx.notification.create({
          // Nested writes inherit organization_id from the parent through the composite tenant FK.
          data: {
            organizationId: orgId,
            recipientUserId: U,
            type: 'test.ping',
            title: 'ping',
            deliveries: { create: { transport: 'push' } },
          },
          include: { deliveries: true },
        }),
      );
      deliveryIds[orgId] = n.deliveries[0]!.id;
    }
    const ours = Object.values(deliveryIds);
    expect(await db.notificationDelivery.count({ where: { id: { in: ours } } })).toBe(0); // invisible without context

    const claim = () =>
      query<{ organization_id: string; delivery_id: string }>(
        appUrl('notifications'),
        'select * from notifications.claim_notification_deliveries(500, 60)',
      );
    const first = (await claim()).filter((r) => ours.includes(r.delivery_id));
    expect(first.map((r) => [r.organization_id, r.delivery_id]).sort()).toEqual(
      [
        [A, deliveryIds[A]],
        [B, deliveryIds[B]],
      ].sort(),
    );
    expect((await claim()).filter((r) => ours.includes(r.delivery_id))).toEqual([]); // leased: not re-claimed

    const claimed = await notifications.withTenant(db, { organizationId: A }, (tx) =>
      tx.notificationDelivery.findUniqueOrThrow({ where: { id: deliveryIds[A]! } }),
    );
    expect(claimed).toMatchObject({ status: 'sending', attemptCount: 1 });
  });

  it('a poison delivery is never re-claimed after 20 attempts', async () => {
    const db = clients.notifications;
    const n = await notifications.withTenant(db, { organizationId: A }, (tx) =>
      tx.notification.create({
        data: {
          organizationId: A,
          recipientUserId: U,
          type: 'test.poison',
          title: 'poison',
          deliveries: {
            create: [
              { transport: 'push', status: 'failed', attemptCount: 20 },
              { transport: 'email', status: 'failed', attemptCount: 19 },
            ],
          },
        },
        include: { deliveries: true },
      }),
    );
    const byTransport = Object.fromEntries(n.deliveries.map((d) => [d.transport, d.id]));
    const claimedIds = (
      await query<{ delivery_id: string }>(
        appUrl('notifications'),
        'select * from notifications.claim_notification_deliveries(500, 60)',
      )
    ).map((r) => r.delivery_id);
    expect(claimedIds).toContain(byTransport.email);
    expect(claimedIds).not.toContain(byTransport.push);
  });
});

describe('administration: audit log tenancy', () => {
  const db = clients.administration;
  const entry = (organizationId: string | null) => ({
    organizationId,
    eventId: randomUUID(),
    occurredAt: new Date(),
    sourceService: 'test',
    actorType: 'system' as const,
    action: 'test.probe',
    resourceType: 'probe',
  });

  it('tenants write and read only their own audit events', async () => {
    const own = await administration.withTenant(db, { organizationId: A }, (tx) =>
      tx.auditLog.create({ data: entry(A) }),
    );
    await expect(
      administration.withTenant(db, { organizationId: A }, (tx) => tx.auditLog.create({ data: entry(B) })),
    ).rejects.toThrow(/row-level security/);
    const visibleToB = await administration.withTenant(db, { organizationId: B }, (tx) =>
      tx.auditLog.findMany({ where: { id: own.id } }),
    );
    expect(visibleToB).toEqual([]);
  });

  it('platform-scope events (no organization) are write-only for the runtime role', async () => {
    const platform = entry(null);
    // INSERT ... RETURNING (Prisma create) must also pass the SELECT policy, which no tenant context
    // satisfies for platform rows — so ingestion writes them with createMany (no RETURNING).
    await expect(db.auditLog.create({ data: platform })).rejects.toThrow(/row-level security/);
    expect((await db.auditLog.createMany({ data: [platform] })).count).toBe(1);
    expect(await db.auditLog.findMany({ where: { eventId: platform.eventId } })).toEqual([]);
    expect(
      await administration.withTenant(db, { organizationId: A }, (tx) =>
        tx.auditLog.count({ where: { eventId: platform.eventId } }),
      ),
    ).toBe(0);
    expect(
      await query(
        adminUrl(),
        'select count(*)::int as n from administration.audit_logs where event_id = $1 and organization_id is null',
        [platform.eventId],
      ),
    ).toEqual([{ n: 1 }]);
  });
});
