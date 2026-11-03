// The organization service owns membership. Every call forwards the caller's own token (kit ServiceClient), so the
// answer is what the caller is allowed to know, and an unreachable service is a 503, never an implicit "allowed".
import { Inject, Injectable } from '@nestjs/common';
import { ApiProblemException, ServiceClient } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import { notFound, unavailable } from '../common/errors.js';

export const ORGANIZATION_CLIENT = Symbol('ORGANIZATION_CLIENT');

export interface OrgMembership {
  organizationId: string;
  /** When the caller's CURRENT organization membership began (a re-invited person gets a new one). */
  joinedAt: Date;
}

interface MembershipBody {
  organizationId?: unknown;
  joinedAt?: unknown;
}

@Injectable()
export class OrganizationDirectory {
  constructor(@Inject(ORGANIZATION_CLIENT) private readonly client: ServiceClient) {}

  /** The caller's active membership of the organization; 404 when the caller is not a member. */
  async membershipOf(orgId: string, req: Request): Promise<OrgMembership> {
    const res = await this.client.get<MembershipBody>(`/api/v1/orgs/${orgId}/me`, req);
    if (res.status === 404 || res.status === 403) throw notFound();
    if (res.status === 401) throw new ApiProblemException(401, 'unauthenticated', 'An access token is required.');
    const joinedAt = typeof res.body?.joinedAt === 'string' ? new Date(res.body.joinedAt) : undefined;
    if (res.status !== 200 || res.body?.organizationId !== orgId || !joinedAt || Number.isNaN(joinedAt.getTime()))
      throw unavailable();
    return { organizationId: orgId, joinedAt };
  }

  /**
   * The ids among `userIds` (at most 100) that are active members of the organization, asked as the caller, each with
   * when their CURRENT membership began.
   */
  async activeMembers(orgId: string, userIds: string[], req: Request): Promise<Map<string, Date>> {
    if (userIds.length === 0) return new Map();
    const query = userIds.map((id) => `userId=${encodeURIComponent(id)}`).join('&');
    const res = await this.client.get<{ data?: { userId?: unknown; joinedAt?: unknown }[] }>(
      `/api/v1/orgs/${orgId}/members?${query}&limit=100`,
      req,
    );
    if (res.status !== 200 || !Array.isArray(res.body?.data)) throw unavailable();
    const wanted = new Set(userIds);
    const members = new Map<string, Date>();
    for (const { userId, joinedAt } of res.body.data) {
      if (typeof userId !== 'string' || !wanted.has(userId)) continue;
      const since = typeof joinedAt === 'string' ? new Date(joinedAt) : undefined;
      if (!since || Number.isNaN(since.getTime())) throw unavailable();
      members.set(userId, since);
    }
    return members;
  }
}
