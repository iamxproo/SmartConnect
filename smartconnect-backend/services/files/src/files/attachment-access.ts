// Who besides the uploader may read a file: whoever MESSAGING says can see a message that attaches it (ADR 0013).
// Asked as the caller (their own token), so the answer is exactly what the caller may know. Fails closed.
import { Inject, Injectable } from '@nestjs/common';
import { ApiProblemException, ServiceClient } from '@smartconnect/backend-kit';
import type { Request } from 'express';

export const MESSAGING_CLIENT = Symbol('MESSAGING_CLIENT');

@Injectable()
export class AttachmentAccess {
  constructor(@Inject(MESSAGING_CLIENT) private readonly client: ServiceClient) {}

  /** GET /api/v1/orgs/{o}/attachments/{fileId}: 200 = visible to the caller, 404 = not. Anything else is a 503. */
  async isVisibleToCaller(orgId: string, fileId: string, req: Request): Promise<boolean> {
    const res = await this.client.get<unknown>(`/api/v1/orgs/${orgId}/attachments/${fileId}`, req);
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    throw new ApiProblemException(503, 'dependency_unavailable', 'A required service is temporarily unavailable.');
  }
}
