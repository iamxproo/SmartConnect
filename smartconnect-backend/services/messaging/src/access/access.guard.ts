// Access gate for every route, after AccessTokenGuard (global, in order). Fail closed, by route kind:
//   - a route with :channelId asks the workspace service whether the caller sees that channel;
//   - a route marked @OrganizationScoped() asks the organization service whether the caller is an active member, then
//     drops conversation memberships that predate the current organization membership;
//   - every other route is refused, so a future route cannot skip authorization by accident.
// There is no admin bypass: whatever the other service answers is final.
import {
  createParamDecorator,
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC, principalOf } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import { ChannelDirectory, type ChannelAccess } from '../channels/channel-directory.js';
import { notFound } from '../common/errors.js';
import { UUID_PATTERN } from '../common/uuid.js';
import { withTenant } from '../database/client.js';
import { PRISMA, type MessagingPrisma } from '../database/prisma.token.js';
import { OrganizationDirectory, type OrgMembership } from './organization-directory.js';

const ORGANIZATION_SCOPED = 'organization_scoped';
/** Marks a controller whose routes live under /orgs/:orgId and need only organization membership. */
export const OrganizationScoped = () => SetMetadata(ORGANIZATION_SCOPED, true);

const channels = new WeakMap<Request, ChannelAccess>();
const memberships = new WeakMap<Request, OrgMembership>();

/** Handler parameter: the caller's verified access to the channel in the path. */
export const CurrentChannel = createParamDecorator((_data: unknown, context: ExecutionContext): ChannelAccess => {
  const access = channels.get(context.switchToHttp().getRequest<Request>());
  if (!access) throw new Error('@CurrentChannel() used on a route that AccessGuard does not protect');
  return access;
});

/** Handler parameter: the caller's verified membership of the organization in the path. */
export const CurrentOrg = createParamDecorator((_data: unknown, context: ExecutionContext): OrgMembership => {
  const membership = memberships.get(context.switchToHttp().getRequest<Request>());
  if (!membership) throw new Error('@CurrentOrg() used on a route that AccessGuard does not protect');
  return membership;
});

const asUuid = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw notFound();
  return value.toLowerCase();
};

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ChannelDirectory) private readonly channelDirectory: ChannelDirectory,
    @Inject(OrganizationDirectory) private readonly organizations: OrganizationDirectory,
    @Inject(PRISMA) private readonly prisma: MessagingPrisma,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    if (context.getType() !== 'http') return false;

    const req = context.switchToHttp().getRequest<Request>();
    const principal = principalOf(req);
    if (!principal) return false;

    if (req.params.channelId !== undefined) {
      const [orgId, workspaceId, channelId] = [req.params.orgId, req.params.workspaceId, req.params.channelId].map(
        asUuid,
      ) as [string, string, string];
      channels.set(req, await this.channelDirectory.accessTo(orgId, workspaceId, channelId, req));
      return true;
    }

    if (this.reflector.getAllAndOverride<boolean>(ORGANIZATION_SCOPED, targets)) {
      const orgId = asUuid(req.params.orgId);
      const membership = await this.organizations.membershipOf(orgId, req);
      await this.dropStaleMemberships(orgId, principal.userId, membership.joinedAt);
      memberships.set(req, membership);
      return true;
    }
    return false;
  }

  /**
   * Conversation memberships (and read cursors) from a PREVIOUS organization membership (the person was removed and
   * later re-invited) must not come back: they predate the current membership and are dropped before anything runs.
   */
  private async dropStaleMemberships(orgId: string, userId: string, since: Date): Promise<void> {
    await withTenant(this.prisma, { organizationId: orgId, userId }, async (tx) => {
      const stale = await tx.conversationMember.findMany({
        where: { userId, joinedAt: { lt: since } },
        select: { conversationId: true },
      });
      if (stale.length === 0) return;
      const conversationIds = stale.map((row) => row.conversationId);
      await tx.messageReadState.deleteMany({ where: { userId, conversationId: { in: conversationIds } } });
      await tx.conversationMember.deleteMany({ where: { userId, conversationId: { in: conversationIds } } });
    });
  }
}
