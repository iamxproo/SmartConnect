// The workspace service owns channels, workspace and channel membership. Every call forwards the caller's own token
// (kit ServiceClient), so the answer is exactly what the caller may know: it already covers organization membership,
// workspace membership and private-channel membership. Anything but a clean 200/404/401 fails closed with 503.
import { Inject, Injectable } from '@nestjs/common';
import { ApiProblemException, ServiceClient } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import { notFound, unavailable } from '../common/errors.js';

export const WORKSPACE_CLIENT = Symbol('WORKSPACE_CLIENT');

export interface ChannelAccess {
  organizationId: string;
  workspaceId: string;
  channelId: string;
  /** The caller belongs to the channel (may post). */
  isMember: boolean;
  /** Channel admins may moderate (delete). */
  isAdmin: boolean;
  archived: boolean;
}

interface ChannelBody {
  id?: unknown;
  workspaceId?: unknown;
  isMember?: unknown;
  myRole?: unknown;
  archivedAt?: unknown;
}

@Injectable()
export class ChannelDirectory {
  constructor(@Inject(WORKSPACE_CLIENT) private readonly client: ServiceClient) {}

  /** The channel as visible to the caller; 404 when it is not visible (or does not exist). */
  async accessTo(orgId: string, workspaceId: string, channelId: string, req: Request): Promise<ChannelAccess> {
    const res = await this.client.get<ChannelBody>(
      `/api/v1/orgs/${orgId}/workspaces/${workspaceId}/channels/${channelId}`,
      req,
    );
    if (res.status === 404 || res.status === 403) throw notFound();
    if (res.status === 401) throw new ApiProblemException(401, 'unauthenticated', 'An access token is required.');
    const body = res.body;
    if (
      res.status !== 200 ||
      typeof body !== 'object' ||
      body === null ||
      typeof body.id !== 'string' ||
      body.id.toLowerCase() !== channelId ||
      typeof body.workspaceId !== 'string' ||
      body.workspaceId.toLowerCase() !== workspaceId ||
      typeof body.isMember !== 'boolean' ||
      !(body.myRole === null || body.myRole === 'admin' || body.myRole === 'member') ||
      !(body.archivedAt === null || typeof body.archivedAt === 'string')
    )
      throw unavailable();
    return {
      organizationId: orgId,
      workspaceId,
      channelId,
      isMember: body.isMember,
      isAdmin: body.myRole === 'admin',
      archived: body.archivedAt !== null,
    };
  }
}
