// The caller's visible channels, as the workspace service lists them for the caller (it already applies organization,
// workspace and private-channel membership). Every page is fetched; anything unexpected is a 503, never "allowed".
import { Inject, Injectable } from '@nestjs/common';
import { ApiProblemException, ServiceClient } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import { unavailable } from '../common/errors.js';
import { UUID_PATTERN } from '../common/uuid.js';
import { WORKSPACE_CLIENT } from '../channels/channel-directory.js';

const PAGE = 100;
/** Bounds the work for one request: 100 pages of 100 channels. */
const MAX_PAGES = 100;

interface ListBody {
  data?: { id?: unknown }[];
  nextCursor?: unknown;
}

@Injectable()
export class VisibleChannels {
  constructor(@Inject(WORKSPACE_CLIENT) private readonly client: ServiceClient) {}

  async idsFor(orgId: string, req: Request): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query: string = `limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await this.client.get<ListBody>(`/api/v1/orgs/${orgId}/channels?${query}`, req);
      if (res.status === 401) throw new ApiProblemException(401, 'unauthenticated', 'An access token is required.');
      const body = res.body;
      if (res.status !== 200 || typeof body !== 'object' || body === null || !Array.isArray(body.data))
        throw unavailable();
      for (const { id } of body.data) {
        if (typeof id !== 'string' || !UUID_PATTERN.test(id)) throw unavailable();
        ids.push(id.toLowerCase());
      }
      if (body.nextCursor === null || body.nextCursor === undefined) return ids;
      if (typeof body.nextCursor !== 'string' || body.nextCursor === cursor) throw unavailable();
      cursor = body.nextCursor;
    }
    throw unavailable();
  }
}
