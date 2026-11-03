// The single authorization gate for organization-scoped routes (`/orgs/:orgId/...`). It resolves the caller's ACTIVE
// membership of an ACTIVE organization inside the tenant's RLS context and enforces the permission a handler declares
// with @RequirePermission(). Not a member (or no such organization) → 404, so ids cannot be probed.
import {
  createParamDecorator,
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiProblemException, principalOf } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import { withTenant } from '../database/client.js';
import { PRISMA, type OrganizationPrisma } from '../database/prisma.token.js';
import { hasPermission, OWNER_ROLE_KEY, type Permission } from './permissions.js';

export interface Membership {
  memberId: string;
  organizationId: string;
  userId: string;
  role: { id: string; key: string; name: string; permissions: string[] };
  title: string | null;
  joinedAt: Date;
}

const REQUIRED_PERMISSION = 'smartconnect:requiredPermission';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const memberships = new WeakMap<Request, Membership>();

/** Handler-level permission requirement, checked by OrgMemberGuard (403 when missing). */
export const RequirePermission = (permission: Permission) => SetMetadata(REQUIRED_PERMISSION, permission);

/** The caller's membership in the organization of the route. */
export const CurrentMembership = createParamDecorator((_data: unknown, context: ExecutionContext): Membership => {
  const membership = memberships.get(context.switchToHttp().getRequest<Request>());
  if (!membership) throw new Error('@CurrentMembership() used on a route without OrgMemberGuard');
  return membership;
});

export const isOwner = (membership: Membership) => membership.role.key === OWNER_ROLE_KEY;

export const notFound = () => new ApiProblemException(404, 'not_found');

@Injectable()
export class OrgMemberGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PRISMA) private readonly prisma: OrganizationPrisma,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const principal = principalOf(req);
    const orgId = req.params.orgId;
    if (!principal || typeof orgId !== 'string' || !UUID.test(orgId)) throw notFound();

    const member = await withTenant(this.prisma, { organizationId: orgId, userId: principal.userId }, (tx) =>
      tx.organizationMember.findFirst({
        where: {
          userId: principal.userId,
          status: 'active',
          organization: { status: 'active', deletedAt: null },
        },
        select: {
          id: true,
          organizationId: true,
          title: true,
          joinedAt: true,
          role: { select: { id: true, key: true, name: true, permissions: true } },
        },
      }),
    );
    if (!member) throw notFound();
    const membership: Membership = {
      memberId: member.id,
      organizationId: member.organizationId,
      userId: principal.userId,
      role: member.role,
      title: member.title,
      joinedAt: member.joinedAt,
    };

    const required = this.reflector.getAllAndOverride<Permission | undefined>(REQUIRED_PERMISSION, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && !hasPermission(membership.role.permissions, required)) {
      throw new ApiProblemException(403, 'forbidden', 'Your role does not allow this action.');
    }
    memberships.set(req, membership);
    return true;
  }
}
