// Invitation lifecycle (ADR 0010, ADR 0017): only holders of members.invite create, list, resend and revoke; tokens are
// 256-bit, stored as SHA-256, single-use and expiring; acceptance requires the caller's VERIFIED account email to equal
// the invited address, and creates the membership in the same transaction that consumes the invitation. Every answer
// says where the invitation's latest email stands (`delivery`), so a failed email is resent, never silently left.
import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiProblemException, type Principal } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import { IdentityClient } from '../access/identity.client.js';
import { isOwner, notFound, type Membership } from '../access/org-member.guard.js';
import { hasPermission, OWNER_ROLE_KEY } from '../access/permissions.js';
import { ORGANIZATION_CONFIG, type OrganizationConfig } from '../config.js';
import { type Prisma, withTenant } from '../database/client.js';
import { PRISMA, type OrganizationPrisma } from '../database/prisma.token.js';
import { conflict, forbidden, invalidField, isUniqueViolation } from '../errors.js';
import { recordEvents } from '../events/outbox.js';
import { decodeCursor, encodeCursor } from '../ids.js';
import {
  INVITATION_DELIVERIES,
  INVITATION_NOTIFIER,
  InvitationDeliveries,
  notifySafely,
  type InvitationDelivery,
  type InvitationNotifier,
} from '../notifications/invitation-notifier.js';
import { settingsOf, toMembership } from '../organizations/organizations.service.js';
import type { CreateInvitationDto, ListInvitationsQueryDto } from './dto.js';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const DAY_MS = 86_400_000;

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');
const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** One answer for unknown, expired, revoked and already-used invitations. */
const invalidInvitation = () =>
  new ApiProblemException(404, 'invitation_invalid', 'This invitation is invalid, expired, revoked or already used.');

/** "ada@example.com" → "a***@example.com": enough to pick the right account, not a full address. */
export function emailHint(email: string): string {
  const at = email.indexOf('@');
  return at <= 0 ? '***' : `${email[0]}***${email.slice(at)}`;
}

const invitationSelect = {
  id: true,
  emailNormalized: true,
  status: true,
  expiresAt: true,
  acceptedAt: true,
  createdAt: true,
  tokenHash: true, // to match the delivery record to the current link; never in an answer
  role: { select: { id: true, key: true, name: true } },
} as const;
type InvitationRow = Prisma.OrganizationInvitationGetPayload<{ select: typeof invitationSelect }>;

/** A pending invitation past its expiry is reported as expired (the row is marked lazily). */
const toInvitation = (row: InvitationRow, delivery: InvitationDelivery, now = new Date()) => ({
  id: row.id,
  email: row.emailNormalized,
  role: row.role,
  status: row.status === 'pending' && row.expiresAt <= now ? 'expired' : row.status,
  expiresAt: row.expiresAt.toISOString(),
  acceptedAt: row.acceptedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  delivery,
});

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger('Invitations');

  constructor(
    @Inject(PRISMA) private readonly prisma: OrganizationPrisma,
    @Inject(ORGANIZATION_CONFIG) private readonly config: OrganizationConfig,
    @Inject(IdentityClient) private readonly identity: IdentityClient,
    @Inject(INVITATION_NOTIFIER) private readonly notifier: InvitationNotifier,
    @Inject(INVITATION_DELIVERIES) private readonly deliveries: InvitationDeliveries,
  ) {}

  async create(membership: Membership, input: CreateInvitationDto) {
    const email = normalizeEmail(input.email);
    const token = randomBytes(32).toString('base64url');
    let created;
    try {
      created = await withTenant(this.prisma, this.context(membership), async (tx) => {
        const role = await tx.organizationRole.findFirst({
          where: { id: input.roleId },
          select: { name: true, key: true },
        });
        if (!role) throw invalidField('roleId', 'unknown_role', 'roleId is not a role of this organization');
        if (role.key === OWNER_ROLE_KEY && !isOwner(membership)) {
          throw forbidden('Only owners can invite owners.', 'owner_required');
        }
        const member = await tx.organizationMember.findFirst({
          where: { email: { equals: email, mode: 'insensitive' } },
          select: { id: true },
        });
        if (member) throw conflict('already_member', 'This person is already a member of the organization.');

        const now = new Date();
        // An expired invitation no longer blocks a new one for the same address.
        await tx.organizationInvitation.updateMany({
          where: { emailNormalized: email, status: 'pending', expiresAt: { lte: now } },
          data: { status: 'expired' },
        });
        const org = await tx.organization.findFirstOrThrow({ select: { name: true, settings: true } });
        const inviter = await tx.organizationMember.findFirstOrThrow({
          where: { id: membership.memberId },
          select: { displayName: true },
        });
        const invitation = await tx.organizationInvitation.create({
          data: {
            organizationId: membership.organizationId,
            emailNormalized: email,
            roleId: input.roleId,
            invitedByUserId: membership.userId,
            tokenHash: sha256Hex(token),
            expiresAt: new Date(now.getTime() + settingsOf(org.settings).invitationExpiryDays * DAY_MS),
          },
          select: invitationSelect,
        });
        return { invitation, organizationName: org.name, roleName: role.name, invitedBy: inviter.displayName };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict(
          'invitation_pending',
          'A pending invitation already exists for this address. Resend it instead.',
        );
      }
      throw error;
    }
    return toInvitation(created.invitation, await this.send(token, created.invitation, created));
  }

  async list(membership: Membership, query: ListInvitationsQueryDto) {
    const limit = query.limit ?? 50;
    const beforeId = decodeCursor(query.cursor);
    if (query.cursor !== undefined && !beforeId) throw invalidField('cursor', 'invalid_cursor', 'cursor is not valid');
    const now = new Date();
    const status = query.status ?? 'pending';
    const statusFilter: Prisma.OrganizationInvitationWhereInput =
      status === 'all'
        ? {}
        : status === 'pending'
          ? { status: 'pending', expiresAt: { gt: now } }
          : status === 'expired'
            ? { OR: [{ status: 'expired' }, { status: 'pending', expiresAt: { lte: now } }] }
            : { status };
    const rows = await withTenant(this.prisma, this.context(membership), (tx) =>
      tx.organizationInvitation.findMany({
        where: { ...statusFilter, ...(beforeId ? { id: { lt: beforeId } } : {}) },
        select: invitationSelect,
        orderBy: { id: 'desc' },
        take: limit + 1,
      }),
    );
    const page = rows.slice(0, limit);
    return {
      data: page.map((row) => toInvitation(row, this.deliveries.of(row.id, row.tokenHash), now)),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!.id) : null,
    };
  }

  /**
   * New token and expiry for a pending or expired invitation; the previous link stops working. An expired one is
   * renewed only if nobody else holds that address's pending invitation and the person has not joined meanwhile.
   */
  async resend(membership: Membership, invitationId: string) {
    const token = randomBytes(32).toString('base64url');
    let result;
    try {
      result = await withTenant(this.prisma, this.context(membership), async (tx) => {
        const current = await tx.organizationInvitation.findFirst({
          where: { id: invitationId },
          select: { status: true, emailNormalized: true, role: { select: { key: true, name: true } } },
        });
        if (!current) throw notFound();
        if (current.status !== 'pending' && current.status !== 'expired')
          throw conflict('invitation_not_pending', 'Only pending or expired invitations can be resent.');
        if (current.role.key === OWNER_ROLE_KEY && !isOwner(membership)) {
          throw forbidden('Only owners can invite owners.', 'owner_required');
        }
        if (
          current.status === 'expired' &&
          (await tx.organizationMember.findFirst({
            where: { email: { equals: current.emailNormalized, mode: 'insensitive' } },
            select: { id: true },
          }))
        ) {
          throw conflict('already_member', 'This person is already a member of the organization.');
        }
        const org = await tx.organization.findFirstOrThrow({ select: { name: true, settings: true } });
        const inviter = await tx.organizationMember.findFirstOrThrow({
          where: { id: membership.memberId },
          select: { displayName: true },
        });
        const invitation = await tx.organizationInvitation.update({
          where: { id: invitationId },
          data: {
            status: 'pending',
            tokenHash: sha256Hex(token),
            expiresAt: new Date(Date.now() + settingsOf(org.settings).invitationExpiryDays * DAY_MS),
          },
          select: invitationSelect,
        });
        return { invitation, organizationName: org.name, roleName: current.role.name, invitedBy: inviter.displayName };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict(
          'invitation_pending',
          'A newer invitation is pending for this address. Resend that one instead.',
        );
      }
      throw error;
    }
    return toInvitation(result.invitation, await this.send(token, result.invitation, result));
  }

  /** Idempotent for already-revoked invitations; accepted ones cannot be revoked (remove the member instead). */
  async revoke(membership: Membership, invitationId: string): Promise<void> {
    await withTenant(this.prisma, this.context(membership), async (tx) => {
      const revoked = await tx.organizationInvitation.updateMany({
        where: { id: invitationId, status: 'pending' },
        data: { status: 'revoked' },
      });
      if (revoked.count === 1) return;
      const current = await tx.organizationInvitation.findFirst({
        where: { id: invitationId },
        select: { status: true },
      });
      if (!current) throw notFound();
      if (current.status !== 'revoked')
        throw conflict('invitation_not_pending', 'Only pending invitations can be revoked.');
    });
  }

  /** Public: what an invitation is for, for its token holder. Reveals only a hint of the invited address. */
  async preview(token: string) {
    const ref = await this.resolve(token);
    const invitation = await withTenant(this.prisma, { organizationId: ref.organizationId }, (tx) =>
      tx.organizationInvitation.findFirst({
        where: {
          id: ref.invitationId,
          status: 'pending',
          expiresAt: { gt: new Date() },
          organization: { status: 'active', deletedAt: null },
        },
        select: {
          emailNormalized: true,
          expiresAt: true,
          role: { select: { name: true } },
          organization: { select: { name: true, slug: true } },
        },
      }),
    );
    if (!invitation) throw invalidInvitation();
    return {
      organization: invitation.organization,
      role: invitation.role,
      emailHint: emailHint(invitation.emailNormalized),
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  async accept(req: Request, principal: Principal, token: string) {
    const ref = await this.resolve(token);
    const account = await this.identity.me(req);
    if (!account.emailVerified) {
      throw forbidden('Verify your email address before accepting invitations.', 'email_not_verified');
    }
    const context = { organizationId: ref.organizationId, userId: principal.userId };
    try {
      return await withTenant(this.prisma, context, async (tx) => {
        const now = new Date();
        const invitation = await tx.organizationInvitation.findFirst({
          where: {
            id: ref.invitationId,
            tokenHash: sha256Hex(token), // a token rotated by a resend meanwhile no longer matches
            status: 'pending',
            expiresAt: { gt: now },
            organization: { status: 'active', deletedAt: null },
          },
          select: {
            id: true,
            emailNormalized: true,
            roleId: true,
            invitedByUserId: true,
            role: { select: { key: true } },
          },
        });
        if (!invitation) throw invalidInvitation();
        // An invitation carries the inviter's authority: if they have since lost it (removed, or no longer allowed
        // to invite — or to grant owner), the invitation is void.
        const inviter = await tx.organizationMember.findFirst({
          where: { userId: invitation.invitedByUserId, status: 'active' },
          select: { role: { select: { key: true, permissions: true } } },
        });
        if (
          !inviter ||
          !hasPermission(inviter.role.permissions, 'members.invite') ||
          (invitation.role.key === OWNER_ROLE_KEY && inviter.role.key !== OWNER_ROLE_KEY)
        ) {
          throw invalidInvitation();
        }
        if (invitation.emailNormalized !== normalizeEmail(account.email)) {
          throw forbidden(
            'This invitation was sent to a different email address. Sign in with the invited address.',
            'invitation_email_mismatch',
          );
        }
        if (await tx.organizationMember.findFirst({ where: { userId: principal.userId }, select: { id: true } })) {
          throw conflict('already_member', 'You are already a member of this organization.');
        }
        // Single use: only the request that flips pending → accepted proceeds, even under concurrency.
        const claimed = await tx.organizationInvitation.updateMany({
          where: { id: invitation.id, status: 'pending' },
          data: { status: 'accepted', acceptedAt: now, acceptedByUserId: principal.userId },
        });
        if (claimed.count !== 1) throw invalidInvitation();
        const member = await tx.organizationMember.create({
          data: {
            organizationId: ref.organizationId,
            userId: principal.userId,
            roleId: invitation.roleId,
            displayName: account.displayName,
            email: account.email,
          },
          select: {
            id: true,
            title: true,
            joinedAt: true,
            role: { select: { id: true, key: true, name: true, permissions: true } },
          },
        });
        await recordEvents(tx, [
          {
            eventType: 'organization.member.joined',
            aggregateType: 'member',
            aggregateId: member.id,
            organizationId: ref.organizationId,
            payload: { organizationId: ref.organizationId, userId: principal.userId, roleKey: invitation.role.key },
          },
        ]);
        return {
          organizationId: ref.organizationId,
          membership: toMembership({
            memberId: member.id,
            organizationId: ref.organizationId,
            userId: principal.userId,
            role: member.role,
            title: member.title,
            joinedAt: member.joinedAt,
          }),
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('already_member', 'You are already a member of this organization.');
      throw error;
    }
  }

  /**
   * Token → (organization, invitation) through the narrow SECURITY DEFINER function: the invitee has no tenant
   * context yet. It returns only still-valid (pending, unexpired) invitations.
   */
  private async resolve(token: string): Promise<{ organizationId: string; invitationId: string }> {
    if (!TOKEN.test(token)) throw invalidInvitation();
    const rows = await this.prisma.$queryRaw<{ organization_id: string; invitation_id: string }[]>`
      SELECT organization_id, invitation_id FROM resolve_invitation_token(${sha256Hex(token)})`;
    const row = rows[0];
    if (!row) throw invalidInvitation();
    return { organizationId: row.organization_id, invitationId: row.invitation_id };
  }

  /** Emails the invitation's current link and returns where that email stands (a queued one settles later). */
  private async send(
    token: string,
    invitation: InvitationRow,
    details: { organizationName: string; roleName: string; invitedBy: string | null },
  ): Promise<InvitationDelivery> {
    const { id, tokenHash } = invitation;
    this.deliveries.record(id, tokenHash, 'queued');
    const delivery = await notifySafely(
      this.notifier,
      this.logger,
      {
        kind: 'organization_invitation',
        to: invitation.emailNormalized,
        token,
        link: `${this.config.webAppUrl}/invitations/accept#token=${token}`,
        organizationName: details.organizationName,
        roleName: details.roleName,
        invitedBy: details.invitedBy,
        expiresAt: invitation.expiresAt,
      },
      (outcome) => this.deliveries.settle(id, tokenHash, outcome),
    );
    // A background notifier may already have settled while `send` ran; only the other outcomes are final here.
    if (delivery !== 'queued') this.deliveries.record(id, tokenHash, delivery);
    return this.deliveries.of(id, tokenHash);
  }

  private context(membership: Membership) {
    return { organizationId: membership.organizationId, userId: membership.userId };
  }
}
