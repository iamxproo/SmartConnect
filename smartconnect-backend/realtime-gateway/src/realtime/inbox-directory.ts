// Asks the messaging service whether a socket's user may follow their conversation inbox in an organization, with the
// user's own token (kit ServiceClient). Messaging owns conversations: it checks the organization membership and first
// drops conversation memberships left over from an earlier membership (a removed and re-invited person), so an inbox
// never receives events of conversations its user no longer belongs to. Fails closed: only a clean 200 whose body
// names exactly the requested organization counts.
import { Inject, Injectable } from '@nestjs/common';
import { ApiProblemException, ServiceClient } from '@smartconnect/backend-kit';
import { randomUUID } from 'node:crypto';
import type { ChannelVisibility } from './channel-directory.js';

export const MESSAGING_CLIENT = Symbol('MESSAGING_CLIENT');

@Injectable()
export class InboxDirectory {
  constructor(@Inject(MESSAGING_CLIENT) private readonly client: ServiceClient) {}

  async access(organizationId: string, authorization: string): Promise<ChannelVisibility> {
    try {
      const res = await this.client.get<{ organizationId?: unknown }>(
        `/api/v1/orgs/${organizationId}/conversations/inbox`,
        { authorization, requestId: randomUUID() },
      );
      if (res.status === 404 || res.status === 403) return 'not_found';
      if (res.status === 401) return 'unauthenticated';
      const id = res.body?.organizationId;
      if (res.status === 200 && typeof id === 'string' && id.toLowerCase() === organizationId) return 'visible';
      return 'unavailable';
    } catch (error) {
      if (error instanceof ApiProblemException) return 'unavailable';
      throw error;
    }
  }
}
