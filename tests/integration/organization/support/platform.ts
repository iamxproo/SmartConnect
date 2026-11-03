// The REAL identity service (listening, so the organization service can call it) and the REAL organization service,
// both on the disposable test database. Users are registered, email-verified and logged in through the identity API.
import type { Server } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createOrganizationApp } from '../../../../smartconnect-backend/services/organization/src/app.factory.js';
import { loadConfig } from '../../../../smartconnect-backend/services/organization/src/config.js';
import { createPrismaClient } from '../../../../smartconnect-backend/services/organization/src/database/client.js';
import {
  InvitationDevMailbox,
  type InvitationNotifier,
} from '../../../../smartconnect-backend/services/organization/src/notifications/invitation-notifier.js';
import { appUrl } from '../../../support/database.js';
import {
  CapturingLogger,
  login,
  PASSWORD,
  register,
  startIdentity,
  uniqueEmail,
  urlOf,
  type TestIdentity,
} from '../../identity/support/identity.js';

export interface Platform {
  identity: TestIdentity;
  app: NestExpressApplication;
  server: Server;
  mailbox: InvitationDevMailbox;
  logger: CapturingLogger;
  /** The one address allowed to create organizations in this suite. */
  founderEmail: string;
  close(): Promise<void>;
}

export async function startPlatform(
  options: {
    /** Replaces the InvitationDevMailbox; built with the service's capturing logger so log assertions see everything. */
    notifier?: (logger: CapturingLogger) => InvitationNotifier;
    /** More organization-service settings (e.g. ORGANIZATION_CREATION=open). */
    env?: Record<string, string>;
  } = {},
): Promise<Platform> {
  const identity = await startIdentity({ listen: true });
  const founderEmail = uniqueEmail('founder');
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: appUrl('organization'),
    AUTH_JWT_PUBLIC_JWKS: identity.publicJwks,
    IDENTITY_SERVICE_URL: urlOf(identity),
    ORGANIZATION_CREATOR_EMAILS: founderEmail,
    ...options.env,
  });
  const prisma = createPrismaClient({ connectionString: config.databaseUrl, maxConnections: 8 });
  const mailbox = new InvitationDevMailbox();
  const logger = new CapturingLogger();
  const notifier = options.notifier?.(logger) ?? mailbox;
  const app = await createOrganizationApp({ config, logger, prisma, notifier });
  await app.init();
  return {
    identity,
    app,
    server: app.getHttpServer(),
    mailbox,
    logger,
    founderEmail,
    close: async () => {
      await app.close();
      await identity.close();
    },
  };
}

export interface User {
  email: string;
  userId: string;
  accessToken: string;
  auth: { Authorization: string };
}

/** Registers, (optionally) verifies the email through the real verification flow, and logs in. */
export async function createUser(platform: Platform, email = uniqueEmail('user'), verify = true): Promise<User> {
  await register(platform.identity.server, email, PASSWORD, email.split('@')[0]);
  if (verify) {
    const [message] = platform.identity.mailbox.list(email).filter((m) => m.kind === 'email_verification');
    if (message?.kind !== 'email_verification') throw new Error('no verification email');
    await request(platform.identity.server)
      .post('/api/v1/auth/email/verify')
      .send({ token: message.token })
      .expect(204);
  }
  const { accessToken } = await login(platform.identity.server, email);
  const me = await request(platform.identity.server)
    .get('/api/v1/auth/me')
    .set('Authorization', `Bearer ${accessToken}`)
    .expect(200);
  return {
    email,
    userId: (me.body as { id: string }).id,
    accessToken,
    auth: { Authorization: `Bearer ${accessToken}` },
  };
}

export interface Org {
  id: string;
  roles: Record<string, string>;
}

let slugCounter = 0;
export const uniqueSlug = (label = 'org') => `${label}-${Date.now().toString(36)}-${++slugCounter}`;

export async function createOrg(platform: Platform, founder: User, slug = uniqueSlug()): Promise<Org> {
  const res = await request(platform.server)
    .post('/api/v1/orgs')
    .set(founder.auth)
    .send({ name: `Org ${slug}`, slug })
    .expect(201);
  const id = (res.body as { id: string }).id;
  const roles = await request(platform.server).get(`/api/v1/orgs/${id}/roles`).set(founder.auth).expect(200);
  const byKey = Object.fromEntries(
    (roles.body as { data: { key: string; id: string }[] }).data.map((r) => [r.key, r.id]),
  );
  return { id, roles: byKey };
}

/** Invites `email` with `role` and returns the raw token from the dev mailbox. */
export async function invite(platform: Platform, inviter: User, org: Org, email: string, role = 'member') {
  await request(platform.server)
    .post(`/api/v1/orgs/${org.id}/invitations`)
    .set(inviter.auth)
    .send({ email, roleId: org.roles[role] })
    .expect(201);
  const [message] = platform.mailbox.list(email);
  if (!message) throw new Error('no invitation email');
  return message.token;
}

/** Invites and accepts: the user becomes a member with `role`. */
export async function addMember(platform: Platform, inviter: User, org: Org, user: User, role = 'member') {
  const token = await invite(platform, inviter, org, user.email, role);
  await request(platform.server).post('/api/v1/invitations/accept').set(user.auth).send({ token }).expect(200);
}
