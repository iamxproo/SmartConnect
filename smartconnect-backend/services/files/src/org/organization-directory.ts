// The organization service owns membership. Every call forwards the caller's own token (kit ServiceClient), so the
// answer is what the caller is allowed to know, and an unreachable service is a 503, never an implicit "allowed".
import { Inject, Injectable } from '@nestjs/common';
import { ApiProblemException, ServiceClient } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import { notFound } from '../common/errors.js';

export const ORGANIZATION_CLIENT = Symbol('ORGANIZATION_CLIENT');

export interface OrgMembership {
  organizationId: string;
  permissions: string[];
  /** When the caller's CURRENT organization membership began (a re-invited person gets a new one). */
  joinedAt: Date;
}

interface MembershipBody {
  organizationId?: unknown;
  joinedAt?: unknown;
  role?: { permissions?: unknown };
}

const unavailable = () =>
  new ApiProblemException(503, 'dependency_unavailable', 'A required service is temporarily unavailable.');

/** `*` grants everything; otherwise the exact permission key is required. */
export const hasPermission = (permissions: readonly string[], key: string) =>
  permissions.includes('*') || permissions.includes(key);

@Injectable()
export class OrganizationDirectory {
  constructor(@Inject(ORGANIZATION_CLIENT) private readonly client: ServiceClient) {}

  /** The caller's active membership of the organization; 404 when the caller is not a member. */
  async membershipOf(orgId: string, req: Request): Promise<OrgMembership> {
    const res = await this.client.get<MembershipBody>(`/api/v1/orgs/${orgId}/me`, req);
    if (res.status === 404 || res.status === 403) throw notFound();
    if (res.status === 401) throw new ApiProblemException(401, 'unauthenticated', 'An access token is required.');
    const permissions = res.body?.role?.permissions;
    const joinedAt = typeof res.body?.joinedAt === 'string' ? new Date(res.body.joinedAt) : undefined;
    if (
      res.status !== 200 ||
      res.body?.organizationId !== orgId ||
      !Array.isArray(permissions) ||
      !permissions.every((p) => typeof p === 'string') ||
      !joinedAt ||
      Number.isNaN(joinedAt.getTime())
    )
      throw unavailable();
    return { organizationId: orgId, permissions, joinedAt };
  }
}
