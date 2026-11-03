// The files service owns files. Every call forwards the caller's own token (kit ServiceClient), so a file is only
// accepted when the files service shows it to the caller AND they uploaded it. Unreachable means 503, never "allowed".
import { Inject, Injectable } from '@nestjs/common';
import { ApiProblemException, ServiceClient } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import { invalid, unavailable } from '../common/errors.js';

export const FILES_CLIENT = Symbol('FILES_CLIENT');

/** What a message keeps of a file when it is attached: it renders without asking the files service again. */
export interface AttachmentSnapshot {
  fileId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

interface FileBody {
  id?: unknown;
  name?: unknown;
  mimeType?: unknown;
  sizeBytes?: unknown;
  status?: unknown;
  uploadedByUserId?: unknown;
}

const notAttachable = () =>
  invalid('attachmentFileIds', 'invalid_attachment', 'Attachments must be your own uploaded files.');

@Injectable()
export class FileDirectory {
  constructor(@Inject(FILES_CLIENT) private readonly client: ServiceClient) {}

  /**
   * Snapshots of the files, in the given order. 422 when any is missing, not the caller's, or not available (the
   * answer never says which, so other people's files cannot be probed); 503 when the files service cannot answer.
   */
  async snapshots(orgId: string, userId: string, fileIds: string[], req: Request): Promise<AttachmentSnapshot[]> {
    return Promise.all(
      fileIds.map(async (fileId) => {
        const res = await this.client.get<FileBody>(`/api/v1/orgs/${orgId}/files/${fileId}`, req);
        if (res.status === 404 || res.status === 403) throw notAttachable();
        if (res.status === 401) throw new ApiProblemException(401, 'unauthenticated', 'An access token is required.');
        const body = res.body;
        if (
          res.status !== 200 ||
          typeof body !== 'object' ||
          body === null ||
          typeof body.id !== 'string' ||
          body.id.toLowerCase() !== fileId ||
          typeof body.name !== 'string' ||
          typeof body.mimeType !== 'string' ||
          typeof body.sizeBytes !== 'number' ||
          typeof body.status !== 'string' ||
          typeof body.uploadedByUserId !== 'string'
        )
          throw unavailable();
        if (body.uploadedByUserId.toLowerCase() !== userId || body.status !== 'available') throw notAttachable();
        return {
          fileId,
          name: body.name.slice(0, 255),
          mimeType: body.mimeType.slice(0, 255),
          sizeBytes: body.sizeBytes,
        };
      }),
    );
  }
}
