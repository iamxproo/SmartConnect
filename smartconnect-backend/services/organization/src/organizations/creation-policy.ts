// Who may create an organization (ADR 0017). "open": any active account with a verified email, up to a number of
// owned organizations each (allowlisted creators are exempt). "allowlist": only ORGANIZATION_CREATOR_EMAILS, with a
// verified email (ADR 0010's original rule). A platform Super Admin never creates organizations (ADR 0015): the role
// is for running the platform, not for joining tenants. Creating one never grants any platform role.
import type { ApiProblemException } from '@smartconnect/backend-kit';
import type { CallerAccount } from '../access/identity.client.js';
import { OWNER_ROLE_KEY } from '../access/permissions.js';
import type { OrganizationConfig } from '../config.js';
import type { Prisma } from '../database/client.js';
import { forbidden } from '../errors.js';

export type CreationRefusal = 'not_allowed' | 'email_not_verified' | 'limit_reached';

export interface CreationEligibility {
  allowed: boolean;
  reason: CreationRefusal | null;
}

type Policy = Pick<OrganizationConfig, 'organizationCreation' | 'organizationCreatorEmails' | 'maxOwnedOrganizations'>;

/** Whether the ownership cap applies to this caller: only in open mode, and never to allowlisted creators. */
export const isCapped = (config: Policy, account: CallerAccount) =>
  config.organizationCreation === 'open' && !config.organizationCreatorEmails.has(account.email.toLowerCase());

/** The refusals that need no database: the platform role, the mode and the email verification. */
export function baseRefusal(config: Policy, account: CallerAccount): CreationRefusal | undefined {
  if (account.platformRoles?.includes('super_admin')) return 'not_allowed';
  const allowlisted = config.organizationCreatorEmails.has(account.email.toLowerCase());
  if (config.organizationCreation === 'allowlist' && !allowlisted) return 'not_allowed';
  if (!account.emailVerified) return 'email_not_verified';
  return undefined;
}

/** Why `account` may not create an organization now, or undefined if it may. `ownedCount` is asked only when capped. */
export async function creationRefusal(
  config: Policy,
  account: CallerAccount,
  ownedCount: () => Promise<number>,
): Promise<CreationRefusal | undefined> {
  const refusal = baseRefusal(config, account);
  if (refusal) return refusal;
  if (isCapped(config, account) && (await ownedCount()) >= config.maxOwnedOrganizations) return 'limit_reached';
  return undefined;
}

export function refusalProblem(reason: CreationRefusal, config: Policy): ApiProblemException {
  if (reason === 'email_not_verified')
    return forbidden('Verify your email address before creating an organization.', 'email_not_verified');
  if (reason === 'limit_reached')
    return forbidden(
      `You already own ${config.maxOwnedOrganizations} organizations, the most one account can own.`,
      'organization_limit_reached',
    );
  return forbidden('Your account is not authorized to create organizations.', 'organization_creation_not_allowed');
}

/** Live organizations the user owns (user-scoped RLS: their own memberships, and the organizations behind them). */
export const ownedOrganizations = (tx: Prisma.TransactionClient, userId: string) =>
  tx.organizationMember.count({
    where: {
      userId,
      status: 'active',
      role: { key: OWNER_ROLE_KEY },
      organization: { status: 'active', deletedAt: null },
    },
  });
