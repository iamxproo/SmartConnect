// Development seed: one idempotent demo tenant ("Acme Demo") for local work.
//
// Written through each service's OWN runtime credentials and Prisma client, inside withTenant(), so it
// obeys the same rules as production code: no service writes another service's schema, and RLS must
// accept every row. Fixed ids + upserts make it safe to re-run. It writes no outbox events, so it seeds
// the messaging membership projection itself. Never run against anything but the local dev database.
//
//   make db-seed
import { readFileSync } from 'node:fs';
import * as administration from '../services/administration/src/database/client.js';
import * as identity from '../services/identity/src/database/client.js';
import * as messaging from '../services/messaging/src/database/client.js';
import * as organization from '../services/organization/src/database/client.js';
import * as workspace from '../services/workspace/src/database/client.js';

const ids = {
  org: '019a4a00-0000-7000-8000-000000000001',
  alice: '019a4a00-0000-7000-8000-0000000a11ce',
  bob: '019a4a00-0000-7000-8000-000000000b0b',
  ownerRole: '019a4a00-0000-7000-8000-000000000101',
  memberRole: '019a4a00-0000-7000-8000-000000000102',
  workspace: '019a4a00-0000-7000-8000-000000000201',
  channel: '019a4a00-0000-7000-8000-000000000301',
  conversation: '019a4a00-0000-7000-8000-000000000401',
  welcome: '019a4a00-0000-7000-8000-000000000501',
} as const;

function runtimeUrl(service: string): string {
  if (process.env.NODE_ENV === 'production') throw new Error('refusing to seed with NODE_ENV=production');
  const env = readFileSync(new URL(`../services/${service}/.env`, import.meta.url), 'utf8');
  const url = env.match(/^DATABASE_URL=(.+)$/m)?.[1];
  if (!url) throw new Error(`${service}: no DATABASE_URL — run \`make db-bootstrap\` first`);
  const { hostname, pathname } = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(hostname) || pathname !== '/smartconnect') {
    throw new Error(`${service}: refusing to seed a non-local database (${hostname}${pathname})`);
  }
  return url;
}

const tenant = { organizationId: ids.org, userId: ids.alice };

async function seedIdentity(): Promise<void> {
  const db = identity.createPrismaClient({ connectionString: runtimeUrl('identity'), maxConnections: 1 });
  try {
    for (const [id, name] of [
      [ids.alice, 'Alice'],
      [ids.bob, 'Bob'],
    ] as const) {
      const email = `${name.toLowerCase()}@acme.example`;
      await db.user.upsert({
        where: { id },
        create: {
          id,
          email,
          emailNormalized: email,
          emailVerifiedAt: new Date(),
          profile: { create: { displayName: name } },
        },
        update: {},
      });
    }
  } finally {
    await db.$disconnect();
  }
}

async function seedOrganization(): Promise<void> {
  const db = organization.createPrismaClient({ connectionString: runtimeUrl('organization'), maxConnections: 1 });
  try {
    await organization.withTenant(db, tenant, async (tx) => {
      await tx.organization.upsert({
        where: { id: ids.org },
        create: { id: ids.org, slug: 'acme-demo', name: 'Acme Demo', createdByUserId: ids.alice },
        update: {},
      });
      for (const [id, key, name, permissions] of [
        [ids.ownerRole, 'owner', 'Owner', ['*']],
        [ids.memberRole, 'member', 'Member', ['workspace.join', 'message.post']],
      ] as const) {
        await tx.organizationRole.upsert({
          where: { organizationId_key: { organizationId: ids.org, key } },
          create: { id, organizationId: ids.org, key, name, permissions: [...permissions], isSystem: true },
          update: {},
        });
      }
      for (const [userId, roleId] of [
        [ids.alice, ids.ownerRole],
        [ids.bob, ids.memberRole],
      ] as const) {
        await tx.organizationMember.upsert({
          where: { organizationId_userId: { organizationId: ids.org, userId } },
          create: { organizationId: ids.org, userId, roleId },
          update: {},
        });
      }
    });
  } finally {
    await db.$disconnect();
  }
}

async function seedWorkspace(): Promise<void> {
  const db = workspace.createPrismaClient({ connectionString: runtimeUrl('workspace'), maxConnections: 1 });
  try {
    await workspace.withTenant(db, tenant, async (tx) => {
      await tx.workspace.upsert({
        where: { id: ids.workspace },
        create: {
          id: ids.workspace,
          organizationId: ids.org,
          name: 'Acme HQ',
          slug: 'acme-hq',
          createdByUserId: ids.alice,
        },
        update: {},
      });
      await tx.channel.upsert({
        where: { id: ids.channel },
        create: {
          id: ids.channel,
          organizationId: ids.org,
          workspaceId: ids.workspace,
          name: 'general',
          isDefault: true,
          createdByUserId: ids.alice,
        },
        update: {},
      });
      for (const userId of [ids.alice, ids.bob]) {
        await tx.workspaceMember.upsert({
          where: { workspaceId_userId: { workspaceId: ids.workspace, userId } },
          create: {
            organizationId: ids.org,
            workspaceId: ids.workspace,
            userId,
            role: userId === ids.alice ? 'admin' : 'member',
          },
          update: {},
        });
        await tx.channelMember.upsert({
          where: { channelId_userId: { channelId: ids.channel, userId } },
          create: { organizationId: ids.org, channelId: ids.channel, userId },
          update: {},
        });
      }
    });
  } finally {
    await db.$disconnect();
  }
}

async function seedMessaging(): Promise<void> {
  const db = messaging.createPrismaClient({ connectionString: runtimeUrl('messaging'), maxConnections: 1 });
  try {
    await messaging.withTenant(db, tenant, async (tx) => {
      await tx.conversation.upsert({
        where: { id: ids.conversation },
        create: {
          id: ids.conversation,
          organizationId: ids.org,
          kind: 'channel',
          workspaceId: ids.workspace,
          channelId: ids.channel,
        },
        update: {},
      });
      for (const userId of [ids.alice, ids.bob]) {
        await tx.conversationMember.upsert({
          where: { conversationId_userId: { conversationId: ids.conversation, userId } },
          create: { organizationId: ids.org, conversationId: ids.conversation, userId },
          update: {},
        });
      }
      await tx.message.upsert({
        where: { id: ids.welcome },
        create: {
          id: ids.welcome,
          organizationId: ids.org,
          conversationId: ids.conversation,
          senderUserId: ids.alice,
          body: 'Welcome to SmartConnect 👋',
        },
        update: {},
      });
      await tx.conversation.update({ where: { id: ids.conversation }, data: { lastMessageAt: new Date() } });
    });
  } finally {
    await db.$disconnect();
  }
}

async function seedAdministration(): Promise<void> {
  const db = administration.createPrismaClient({ connectionString: runtimeUrl('administration'), maxConnections: 1 });
  try {
    await administration.withTenant(db, tenant, async (tx) => {
      for (const [resourceType, retentionDays] of [
        ['search_history', 30],
        ['webhook_deliveries', 30],
        ['meeting_events', 90],
      ] as const) {
        await tx.retentionPolicy.upsert({
          where: { organizationId_resourceType: { organizationId: ids.org, resourceType } },
          create: { organizationId: ids.org, resourceType, retentionDays, updatedByUserId: ids.alice },
          update: {},
        });
      }
    });
  } finally {
    await db.$disconnect();
  }
}

for (const [name, step] of [
  ['identity', seedIdentity],
  ['organization', seedOrganization],
  ['workspace', seedWorkspace],
  ['messaging', seedMessaging],
  ['administration', seedAdministration],
] as const) {
  await step();
  console.log(`✔ seeded ${name}`);
}
console.log(`Demo tenant "Acme Demo" (organization ${ids.org}) is ready.`);
