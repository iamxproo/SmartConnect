// Organization membership gate for every route under /orgs/{orgId}. Runs after AccessTokenGuard (global, in order).
// Routes without an :orgId path parameter are refused, so a future route cannot skip the membership check by accident.
import { createParamDecorator, Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC, principalOf } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import { notFound } from '../common/errors.js';
import { withTenant } from '../database/client.js';
import { PRISMA, type WorkspacePrisma } from '../database/prisma.token.js';
import { OrganizationDirectory, type OrgMembership } from './organization-directory.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const memberships = new WeakMap<Request, OrgMembership>();

/** Handler parameter: the caller's verified membership of the organization in the path. */
export const CurrentOrg = createParamDecorator((_data: unknown, context: ExecutionContext): OrgMembership => {
  const membership = memberships.get(context.switchToHttp().getRequest<Request>());
  if (!membership) throw new Error('@CurrentOrg() used on a route that OrgMembershipGuard does not protect');
  return membership;
});

@Injectable()
export class OrgMembershipGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(OrganizationDirectory) private readonly directory: OrganizationDirectory,
    @Inject(PRISMA) private readonly prisma: WorkspacePrisma,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;
    if (context.getType() !== 'http') return false;

    const req = context.switchToHttp().getRequest<Request>();
    const principal = principalOf(req);
    if (!principal) return false;
    const orgId = req.params.orgId;
    if (typeof orgId !== 'string' || !UUID.test(orgId)) throw notFound();
    const membership = await this.directory.membershipOf(orgId, req);
    // Workspace and channel memberships from a PREVIOUS organization membership (the person was removed and later
    // re-invited) must not come back: they predate the current membership and are dropped before anything runs.
    // Until the organization.member.removed event is consumed, this is where such rows are cleaned up.
    await withTenant(this.prisma, { organizationId: orgId, userId: principal.userId }, async (tx) => {
      await tx.channelMember.deleteMany({ where: { userId: principal.userId, joinedAt: { lt: membership.joinedAt } } });
      await tx.workspaceMember.deleteMany({
        where: { userId: principal.userId, joinedAt: { lt: membership.joinedAt } },
      });
    });
    memberships.set(req, membership);
    return true;
  }
}
