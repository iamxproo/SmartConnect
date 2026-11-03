import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasPermission, PERMISSIONS, SYSTEM_ROLES } from '../src/access/permissions.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { decodeCursor, encodeCursor, uuidv7 } from '../src/ids.js';
import { emailHint } from '../src/invitations/invitations.service.js';
import { OrganizationsController } from '../src/organizations/organizations.controller.js';
import { OrganizationsService } from '../src/organizations/organizations.service.js';
import { creationRefusal } from '../src/organizations/creation-policy.js';
import { CreateOrganizationDto, ORGANIZATION_NAME, ORGANIZATION_SLUG } from '../src/organizations/dto.js';
import { InvitationDeliveries } from '../src/notifications/invitation-notifier.js';

const { publicKey } = generateKeyPairSync('ed25519');
const jwks = JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1' }] });
const base = { DATABASE_URL: 'postgresql://u:p@127.0.0.1:15433/x', AUTH_JWT_PUBLIC_JWKS: jwks };

function problemsOf(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe('organization config', () => {
  it('defaults: port 3102, the allowlist with nobody on it (fail closed), a cap of 10 owned, dev mailbox', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      port: 3102,
      invitationNotifier: 'dev-mailbox',
      identityServiceUrl: 'http://127.0.0.1:3101',
      organizationCreation: 'allowlist',
      maxOwnedOrganizations: 10,
    });
    expect(config.organizationCreatorEmails.size).toBe(0);
  });

  it('takes the organization creation mode and the ownership cap, and rejects anything else', () => {
    expect(loadConfig({ ...base, ORGANIZATION_CREATION: 'open' }).organizationCreation).toBe('open');
    expect(loadConfig({ ...base, ORGANIZATION_MAX_OWNED_PER_USER: '3' }).maxOwnedOrganizations).toBe(3);
    expect(problemsOf({ ...base, ORGANIZATION_CREATION: 'everyone', ORGANIZATION_MAX_OWNED_PER_USER: '0' })).toEqual([
      'ORGANIZATION_CREATION must be one of open, allowlist',
      'ORGANIZATION_MAX_OWNED_PER_USER must be an integer from 1 to 1000',
    ]);
  });

  it('normalises the creator allowlist and rejects malformed entries', () => {
    expect([
      ...loadConfig({ ...base, ORGANIZATION_CREATOR_EMAILS: ' Ada@Example.com, ,bob@example.com' })
        .organizationCreatorEmails,
    ]).toEqual(['ada@example.com', 'bob@example.com']);
    expect(problemsOf({ ...base, ORGANIZATION_CREATOR_EMAILS: 'not-an-email' })).toEqual([
      'ORGANIZATION_CREATOR_EMAILS must be a comma-separated list of email addresses',
    ]);
  });

  it('requires secrets, service URLs and an explicit notifier in production; refuses the dev mailbox there', () => {
    expect(problemsOf({})).toEqual([
      'DATABASE_URL is required (locally: make db-bootstrap writes it to services/organization/.env)',
      'AUTH_JWT_PUBLIC_JWKS (or AUTH_JWT_PUBLIC_JWKS_FILE) is required; locally: make auth-dev-keys',
    ]);
    expect(problemsOf({ ...base, NODE_ENV: 'production' })).toEqual([
      'IDENTITY_SERVICE_URL is required in production',
      'WEB_APP_URL is required in production',
      'ORGANIZATION_CREATION is required in production ("open": any verified account; "allowlist": ORGANIZATION_CREATOR_EMAILS only)',
      'INVITATION_NOTIFIER is required in production ("smtp" sends mail; "disabled" drops it)',
      'INVITATION_NOTIFIER=dev-mailbox is not allowed in production (it exposes invitation tokens over HTTP)',
    ]);
  });

  it('requires an https web app URL in production (invitation links carry one-time tokens)', () => {
    const production = {
      ...base,
      NODE_ENV: 'production',
      IDENTITY_SERVICE_URL: 'https://identity.internal.example.com',
      INVITATION_NOTIFIER: 'disabled',
      ORGANIZATION_CREATION: 'open',
    };
    expect(problemsOf({ ...production, WEB_APP_URL: 'http://app.example.com' })).toEqual([
      'WEB_APP_URL must be https in production (invitation links carry one-time tokens)',
    ]);
    expect(loadConfig({ ...production, WEB_APP_URL: 'https://app.example.com' }).webAppUrl).toBe(
      'https://app.example.com',
    );
  });

  describe('INVITATION_NOTIFIER=smtp', () => {
    const smtpEnv = {
      INVITATION_NOTIFIER: 'smtp',
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_USER: 'mailer@example.com',
      SMTP_PASSWORD: 'abcd efgh ijkl mnop',
      SMTP_FROM: 'SmartConnect <mailer@example.com>',
    };

    it('reads the SMTP settings and is allowed in production', () => {
      expect(loadConfig({ ...base, ...smtpEnv }).smtp).toMatchObject({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        password: 'abcdefghijklmnop',
      });
      const production = {
        ...base,
        ...smtpEnv,
        NODE_ENV: 'production',
        IDENTITY_SERVICE_URL: 'https://identity.internal.example.com',
        WEB_APP_URL: 'https://app.example.com',
        ORGANIZATION_CREATION: 'allowlist',
      };
      expect(loadConfig(production).invitationNotifier).toBe('smtp');
    });

    it('names missing settings without echoing values, and ignores them for other notifiers', () => {
      expect(problemsOf({ ...base, INVITATION_NOTIFIER: 'smtp' })).toEqual([
        'SMTP_HOST is required to send email through SMTP',
        'SMTP_USER is required to send email through SMTP',
        'SMTP_PASSWORD (or SMTP_PASSWORD_FILE) is required to send email through SMTP',
        'SMTP_FROM is required: an address, or "Name <address>"',
      ]);
      const problems = problemsOf({ ...base, ...smtpEnv, SMTP_PORT: '0' });
      expect(problems).toEqual(['SMTP_PORT must be an integer from 1 to 65535']);
      expect(problems.join(' ')).not.toContain('abcd');
      expect(loadConfig({ ...base, ...smtpEnv, INVITATION_NOTIFIER: 'disabled' }).smtp).toBeUndefined();
    });
  });
});

describe('start script', () => {
  // The creator allowlist and SMTP settings live in gitignored files at the repository root, because make db-bootstrap
  // rewrites this service's own .env. Real environment variables still take precedence over all three files.
  it('loads .env, then .secrets/smtp.env, then .secrets/organization.env', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: { start: string };
    };
    expect(pkg.scripts.start.split(' ').filter((arg) => arg.startsWith('--env-file'))).toEqual([
      '--env-file-if-exists=.env',
      '--env-file-if-exists=../../../.secrets/smtp.env',
      '--env-file-if-exists=../../../.secrets/organization.env',
    ]);
    // `start` runs in the service directory: ../../../ must be the monorepo root, where .secrets/ lives.
    const root = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as {
      name: string;
    };
    expect(root.name).toBe('smartconnect');
  });
});

describe('permissions', () => {
  it('owner has everything, admin every catalogue permission, member nothing', () => {
    const [owner, admin, member] = SYSTEM_ROLES;
    for (const permission of PERMISSIONS) {
      expect(hasPermission(owner!.permissions, permission)).toBe(true);
      expect(hasPermission(admin!.permissions, permission)).toBe(true);
      expect(hasPermission(member!.permissions, permission)).toBe(false);
    }
    expect(hasPermission(['workspace.join', 'message.post'], 'members.manage')).toBe(false);
  });
});

describe('organization creation policy', () => {
  const account = (over: Partial<Parameters<typeof creationRefusal>[1]> = {}) => ({
    id: 'u1',
    email: 'ada@example.com',
    emailVerified: true,
    displayName: 'Ada',
    platformRoles: [] as string[],
    ...over,
  });
  const policy = (organizationCreation: 'open' | 'allowlist', creators: string[] = []) => ({
    organizationCreation,
    organizationCreatorEmails: new Set(creators),
    maxOwnedOrganizations: 2,
  });
  const owning = (count: number) => () => Promise.resolve(count);

  it('open: any verified account, up to the cap; allowlisted creators are exempt from it', async () => {
    expect(await creationRefusal(policy('open'), account(), owning(1))).toBeUndefined();
    expect(await creationRefusal(policy('open'), account(), owning(2))).toBe('limit_reached');
    expect(await creationRefusal(policy('open', ['ada@example.com']), account(), owning(50))).toBeUndefined();
    expect(await creationRefusal(policy('open'), account({ emailVerified: false }), owning(0))).toBe(
      'email_not_verified',
    );
  });

  it('allowlist: only listed, verified addresses (any letter case), never counting', async () => {
    const counted = () => Promise.reject(new Error('must not count'));
    expect(await creationRefusal(policy('allowlist'), account(), counted)).toBe('not_allowed');
    expect(
      await creationRefusal(policy('allowlist', ['ada@example.com']), account({ email: 'Ada@Example.com' }), counted),
    ).toBeUndefined();
    expect(
      await creationRefusal(policy('allowlist', ['ada@example.com']), account({ emailVerified: false }), counted),
    ).toBe('email_not_verified');
    // Not on the list: refused as not allowed, whatever the verification.
    expect(await creationRefusal(policy('allowlist'), account({ emailVerified: false }), counted)).toBe('not_allowed');
  });

  it('never lets a platform Super Admin create organizations, in either mode', async () => {
    const admin = account({ platformRoles: ['super_admin'] });
    expect(await creationRefusal(policy('open'), admin, owning(0))).toBe('not_allowed');
    expect(await creationRefusal(policy('allowlist', ['ada@example.com']), admin, owning(0))).toBe('not_allowed');
  });
});

describe('organization names and handles', () => {
  it('accept letters or digits in any script; refuse control and text-direction characters, and symbol-only names', () => {
    for (const name of ['Acme Corporation', 'Ünïcödé GmbH', '株式会社', 'R&D 2', 'Café ☕'])
      expect(ORGANIZATION_NAME.test(name), name).toBe(true);
    for (const name of ['!!!', 'ab\u202Ecd', 'a\u2066b', 'a\tb', 'line\nbreak', '\u0007bell'])
      expect(ORGANIZATION_NAME.test(name), JSON.stringify(name)).toBe(false);
  });

  it('refuse handles shaped like an id, which web addresses would read as one', () => {
    expect(ORGANIZATION_SLUG.test('acme')).toBe(true);
    expect(ORGANIZATION_SLUG.test('019a4a00-0000-7000-8000-000000000001')).toBe(false);
    expect(ORGANIZATION_SLUG.test('019a4a00-0000-7000-8000-00000000000')).toBe(true); // one digit short: a handle
    expect(ORGANIZATION_SLUG.test('-acme')).toBe(false);
  });
});

describe('invitation delivery record', () => {
  it('follows the current link only, and forgets the oldest entries first', () => {
    const deliveries = new InvitationDeliveries(2);
    deliveries.record('i1', 'hash-a', 'queued');
    expect(deliveries.of('i1', 'hash-a')).toBe('queued');
    deliveries.settle('i1', 'hash-a', 'failed');
    expect(deliveries.of('i1', 'hash-a')).toBe('failed');
    // A resend replaces the link: the old link's late outcome changes nothing, and its state is not the new one's.
    deliveries.record('i1', 'hash-b', 'queued');
    deliveries.settle('i1', 'hash-a', 'sent');
    expect(deliveries.of('i1', 'hash-b')).toBe('queued');
    expect(deliveries.of('i1', 'hash-a')).toBe('unknown');
    deliveries.record('i2', 'h', 'sent');
    deliveries.record('i3', 'h', 'sent');
    expect(deliveries.of('i1', 'hash-b')).toBe('unknown'); // evicted
    expect(deliveries.of('i3', 'h')).toBe('sent');
  });
});

describe('ids', () => {
  it('uuidv7 is a valid, time-ordered version-7 UUID', () => {
    const first = uuidv7(1_700_000_000_000);
    const second = uuidv7(1_700_000_000_001);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first < second).toBe(true);
  });

  it('cursors round-trip and reject garbage', () => {
    const id = uuidv7();
    expect(decodeCursor(encodeCursor(id))).toBe(id);
    expect(decodeCursor('bm90LWEtdXVpZA')).toBeUndefined();
  });

  it('email hints reveal only the first character and the domain', () => {
    expect(emailHint('ada.lovelace@example.com')).toBe('a***@example.com');
    expect(emailHint('broken')).toBe('***');
  });
});

describe('decorator metadata', () => {
  it('is emitted for DI and DTO validation', () => {
    expect(Reflect.getMetadata('design:paramtypes', OrganizationsController)).toEqual([OrganizationsService]);
    expect(Reflect.getMetadata('design:type', CreateOrganizationDto.prototype, 'slug')).toBe(String);
  });
});
