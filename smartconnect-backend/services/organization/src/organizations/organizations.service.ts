import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import { IdentityClient } from '../access/identity.client.js';
import { isOwner, notFound, type Membership } from '../access/org-member.guard.js';
import { hasPermission, OWNER_ROLE_KEY, SYSTEM_ROLES } from '../access/permissions.js';
import { ORGANIZATION_CONFIG, type OrganizationConfig } from '../config.js';
import { type Prisma, withTenant, withUser } from '../database/client.js';
import { PRISMA, type OrganizationPrisma } from '../database/prisma.token.js';
import { conflict, forbidden, invalidField, isUniqueViolation } from '../errors.js';
import { recordEvents } from '../events/outbox.js';
import { decodeCursor, encodeCursor, uuidv7 } from '../ids.js';
import type { CreateOrganizationDto, ListMembersQueryDto, UpdateMemberDto, UpdateOrganizationDto } from './dto.js';

export interface OrganizationSettings {
  invitationExpiryDays: number;
}

export const DEFAULT_SETTINGS: OrganizationSettings = { invitationExpiryDays: 7 };

export function settingsOf(raw: Prisma.JsonValue): OrganizationSettings {
  const days = (raw as { invitationExpiryDays?: unknown } | null)?.invitationExpiryDays;
  return { invitationExpiryDays: typeof days === 'number' ? days : DEFAULT_SETTINGS.invitationExpiryDays };
}

const organizationSelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  status: true,
  settings: true,
  createdAt: true,
} as const;

/** Prisma's `contains` does not escape LIKE wildcards: `%`, `_` and the escape character itself must match literally. */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, '\\$&');

const memberSelect = {
  id: true,
  userId: true,
  displayName: true,
  email: true,
  title: true,
  status: true,
  joinedAt: true,
  role: { select: { id: true, key: true, name: true } },
} as const;

type OrganizationRow = Prisma.OrganizationGetPayload<{ select: typeof organizationSelect }>;
type MemberRow = Prisma.OrganizationMemberGetPayload<{ select: typeof memberSelect }>;

export const toOrganization = (org: OrganizationRow) => ({
  id: org.id,
  slug: org.slug,
  name: org.name,
  description: org.description,
  status: org.status,
  settings: settingsOf(org.settings),
  createdAt: org.createdAt.toISOString(),
});

export const toMember = (member: MemberRow) => ({
  id: member.id,
  userId: member.userId,
  displayName: member.displayName,
  email: member.email,
  role: member.role,
  title: member.title,
  status: member.status,
  joinedAt: member.joinedAt.toISOString(),
});

export const toMembership = (membership: Membership) => ({
  memberId: membership.memberId,
  organizationId: membership.organizationId,
  role: membership.role,
  title: membership.title,
  joinedAt: membership.joinedAt.toISOString(),
});

@Injectable()
export class OrganizationsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: OrganizationPrisma,
    @Inject(ORGANIZATION_CONFIG) private readonly config: OrganizationConfig,
    @Inject(IdentityClient) private readonly identity: IdentityClient,
  ) {}

  /** The caller's organizations (the one deliberate cross-tenant read: user-scoped RLS policies). */
  async listMine(userId: string) {
    const rows = await withUser(this.prisma, userId, (tx) =>
      tx.organizationMember.findMany({
        where: { userId, status: 'active', organization: { status: 'active', deletedAt: null } },
        select: {
          organization: { select: { id: true, slug: true, name: true } },
          role: { select: { key: true, name: true } },
        },
        orderBy: { organization: { name: 'asc' } },
        take: 200,
      }),
    );
    return { data: rows.map((row) => ({ ...row.organization, role: row.role })), nextCursor: null };
  }

  /**
   * Companies are created by authorized administrators only: the caller's VERIFIED email must be on the configured
   * allowlist. The creator becomes the first owner; system roles are created with the organization.
   */
  async create(req: Request, principal: Principal, input: CreateOrganizationDto) {
    const account = await this.identity.me(req);
    if (!account.emailVerified || !this.config.organizationCreatorEmails.has(account.email.toLowerCase())) {
      throw forbidden('Your account is not authorized to create organizations.', 'organization_creation_not_allowed');
    }
    const organizationId = uuidv7();
    try {
      return await withTenant(this.prisma, { organizationId, userId: principal.userId }, async (tx) => {
        const org = await tx.organization.create({
          data: {
            id: organizationId,
            slug: input.slug,
            name: input.name,
            description: input.description ?? null,
            settings: { ...DEFAULT_SETTINGS },
            createdByUserId: principal.userId,
          },
          select: organizationSelect,
        });
        let ownerRoleId = '';
        for (const role of SYSTEM_ROLES) {
          const created = await tx.organizationRole.create({
            data: { organizationId, ...role, isSystem: true },
            select: { id: true },
          });
          if (role.key === OWNER_ROLE_KEY) ownerRoleId = created.id;
        }
        const member = await tx.organizationMember.create({
          data: {
            organizationId,
            userId: principal.userId,
            roleId: ownerRoleId,
            displayName: account.displayName,
            email: account.email,
          },
          select: { id: true },
        });
        await recordEvents(tx, [
          {
            eventType: 'organization.created',
            aggregateType: 'organization',
            aggregateId: organizationId,
            organizationId,
            payload: { organizationId, createdByUserId: principal.userId },
          },
          {
            eventType: 'organization.member.joined',
            aggregateType: 'member',
            aggregateId: member.id,
            organizationId,
            payload: { organizationId, userId: principal.userId, roleKey: OWNER_ROLE_KEY },
          },
        ]);
        return toOrganization(org);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('slug_taken', 'This organization handle is already in use.');
      throw error;
    }
  }

  async get(membership: Membership) {
    const org = await withTenant(this.prisma, this.context(membership), (tx) =>
      tx.organization.findFirstOrThrow({ select: organizationSelect }),
    );
    return toOrganization(org);
  }

  async update(membership: Membership, input: UpdateOrganizationDto) {
    const org = await withTenant(this.prisma, this.context(membership), async (tx) => {
      const current = await tx.organization.findFirstOrThrow({ select: { settings: true } });
      return tx.organization.update({
        where: { id: membership.organizationId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.settings ? { settings: { ...settingsOf(current.settings), ...input.settings } } : {}),
        },
        select: organizationSelect,
      });
    });
    return toOrganization(org);
  }

  async roles(membership: Membership) {
    const roles = await withTenant(this.prisma, this.context(membership), (tx) =>
      tx.organizationRole.findMany({
        select: { id: true, key: true, name: true, description: true, permissions: true, isSystem: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return { data: roles };
  }

  async listMembers(membership: Membership, query: ListMembersQueryDto) {
    const limit = query.limit ?? 50;
    const afterId = decodeCursor(query.cursor);
    if (query.cursor !== undefined && !afterId) throw invalidField('cursor', 'invalid_cursor', 'cursor is not valid');
    const rows = await withTenant(this.prisma, this.context(membership), (tx) =>
      tx.organizationMember.findMany({
        where: {
          status: 'active',
          ...(query.userId ? { userId: { in: query.userId } } : {}),
          ...(query.q
            ? {
                OR: [
                  { displayName: { contains: escapeLike(query.q), mode: 'insensitive' as const } },
                  { email: { contains: escapeLike(query.q), mode: 'insensitive' as const } },
                ],
              }
            : {}),
          ...(afterId ? { id: { gt: afterId } } : {}),
        },
        select: memberSelect,
        orderBy: { id: 'asc' },
        take: limit + 1,
      }),
    );
    const page = rows.slice(0, limit);
    return {
      data: page.map(toMember),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!.id) : null,
    };
  }

  /** Role/title change. Only owners may grant or take away the owner role; the last owner cannot be demoted. */
  async updateMember(membership: Membership, memberId: string, input: UpdateMemberDto) {
    const updated = await withTenant(this.prisma, this.context(membership), async (tx) => {
      const target = await tx.organizationMember.findFirst({
        where: { id: memberId, status: 'active' },
        select: { id: true, userId: true, role: { select: { id: true, key: true } } },
      });
      if (!target) throw notFound();
      let roleChange: { id: string; key: string } | undefined;
      if (input.roleId !== undefined && input.roleId !== target.role.id) {
        const role = await tx.organizationRole.findFirst({
          where: { id: input.roleId },
          select: { id: true, key: true },
        });
        if (!role) throw invalidField('roleId', 'unknown_role', 'roleId is not a role of this organization');
        if ((role.key === OWNER_ROLE_KEY || target.role.key === OWNER_ROLE_KEY) && !isOwner(membership)) {
          throw forbidden('Only owners can grant or remove the owner role.', 'owner_required');
        }
        if (target.role.key === OWNER_ROLE_KEY) await this.assertAnotherOwner(tx, membership, target.id);
        roleChange = role;
      }
      const member = await tx.organizationMember.update({
        where: { id: target.id },
        data: {
          ...(roleChange ? { roleId: roleChange.id } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
        },
        select: memberSelect,
      });
      if (roleChange) {
        await recordEvents(tx, [
          {
            eventType: 'organization.member.role_changed',
            aggregateType: 'member',
            aggregateId: target.id,
            organizationId: membership.organizationId,
            payload: { organizationId: membership.organizationId, userId: target.userId, roleKey: roleChange.key },
          },
        ]);
      }
      return member;
    });
    return toMember(updated);
  }

  /** Removal by a member manager, or leaving (self). Team memberships go with it, in the same transaction. */
  async removeMember(membership: Membership, memberId: string): Promise<void> {
    await withTenant(this.prisma, this.context(membership), async (tx) => {
      const target = await tx.organizationMember.findFirst({
        where: { id: memberId, status: 'active' },
        select: { id: true, userId: true, role: { select: { key: true } } },
      });
      if (!target) throw notFound();
      const leaving = target.userId === membership.userId;
      if (!leaving && !hasPermission(membership.role.permissions, 'members.manage')) {
        throw forbidden('Your role does not allow this action.');
      }
      if (target.role.key === OWNER_ROLE_KEY) {
        if (!leaving && !isOwner(membership)) throw forbidden('Only owners can remove an owner.', 'owner_required');
        await this.assertAnotherOwner(tx, membership, target.id);
      }
      // Member row first: it waits for any team-membership insert holding it FOR SHARE, so the deleteMany below sees
      // (and removes) that insert too.
      await tx.organizationMember.delete({ where: { id: target.id } });
      await tx.teamMember.deleteMany({ where: { userId: target.userId } });
      await recordEvents(tx, [
        {
          eventType: 'organization.member.removed',
          aggregateType: 'member',
          aggregateId: target.id,
          organizationId: membership.organizationId,
          payload: { organizationId: membership.organizationId, userId: target.userId },
        },
      ]);
    });
  }

  /**
   * Locks the active owners' rows (FOR UPDATE) before counting, so two owners demoting or removing each other at the
   * same time cannot leave the organization without an owner.
   */
  private async assertAnotherOwner(tx: Prisma.TransactionClient, membership: Membership, exceptMemberId: string) {
    const owners = await tx.$queryRaw<{ id: string }[]>`
      SELECT m.id FROM organization_members m JOIN organization_roles r ON r.id = m.role_id
       WHERE m.organization_id = ${membership.organizationId}::uuid AND r.key = ${OWNER_ROLE_KEY} AND m.status = 'active'
       FOR UPDATE OF m`;
    if (!owners.some((owner) => owner.id !== exceptMemberId)) {
      throw conflict('last_owner', 'An organization must keep at least one owner.');
    }
  }

  private context(membership: Membership) {
    return { organizationId: membership.organizationId, userId: membership.userId };
  }
}
