// Asks the workspace service whether a channel is visible to a socket's user, with the user's own token (kit
// ServiceClient), so the answer already covers organization, workspace and private-channel membership. Fails closed:
// only a clean 200 whose body names exactly the requested channel counts as visible.
import { Inject, Injectable } from '@nestjs/common';
import { ApiProblemException, ServiceClient } from '@smartconnect/backend-kit';
import { randomUUID } from 'node:crypto';

export const WORKSPACE_CLIENT = Symbol('WORKSPACE_CLIENT');

export interface ChannelRef {
  organizationId: string;
  workspaceId: string;
  channelId: string;
}

export type ChannelVisibility = 'visible' | 'not_found' | 'unauthenticated' | 'unavailable';

@Injectable()
export class ChannelDirectory {
  constructor(@Inject(WORKSPACE_CLIENT) private readonly client: ServiceClient) {}

  async visibility(ref: ChannelRef, authorization: string): Promise<ChannelVisibility> {
    try {
      const res = await this.client.get<{ id?: unknown; workspaceId?: unknown }>(
        `/api/v1/orgs/${ref.organizationId}/workspaces/${ref.workspaceId}/channels/${ref.channelId}`,
        { authorization, requestId: randomUUID() },
      );
      if (res.status === 404 || res.status === 403) return 'not_found';
      if (res.status === 401) return 'unauthenticated';
      const body = res.body;
      if (
        res.status === 200 &&
        typeof body === 'object' &&
        body !== null &&
        typeof body.id === 'string' &&
        body.id.toLowerCase() === ref.channelId &&
        typeof body.workspaceId === 'string' &&
        body.workspaceId.toLowerCase() === ref.workspaceId
      )
        return 'visible';
      return 'unavailable';
    } catch (error) {
      if (error instanceof ApiProblemException) return 'unavailable';
      throw error;
    }
  }
}
