// File rules (ADR 0013). Metadata lives in PostgreSQL under row-level security; bytes live behind FileStorage.
// Read access: the uploader, or whoever messaging says can see a message attaching the file. A file nobody may read
// is a 404, never a 403, so ids reveal nothing. The database is never held open while bytes move.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiProblemException } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import type { Readable } from 'node:stream';
import { notFound } from '../common/errors.js';
import { paginate, type Page } from '../common/pagination.js';
import { uuidv7 } from '../common/uuid7.js';
import { FILES_CONFIG, type FilesConfig } from '../config.js';
import { withTenant } from '../database/client.js';
import { PRISMA, type FilesPrisma } from '../database/prisma.token.js';
import {
  FILE_STORAGE,
  storageKeyOf,
  StorageInterruptedError,
  StorageLimitError,
  StorageNotFoundError,
  StorageSizeMismatchError,
  type FileStorage,
} from '../storage/file-storage.js';
import { AttachmentAccess } from './attachment-access.js';
import { detectContentType, OCTET_STREAM, SNIFF_HEAD_BYTES, TextSniffer } from './content-type.js';
import type { CreateFileDto, FileDto, FileListDto } from './dto.js';
import { sanitizeFileName } from './names.js';

export interface Actor {
  organizationId: string;
  userId: string;
}

interface FileRow {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: bigint;
  status: FileDto['status'];
  uploadedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

const toFile = (row: FileRow): FileDto => ({
  id: row.id,
  name: row.name,
  mimeType: row.mimeType,
  sizeBytes: Number(row.sizeBytes),
  status: row.status,
  uploadedByUserId: row.uploadedByUserId,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** Backslash first, then the two LIKE wildcards (PostgreSQL's default escape character is the backslash). */
export const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (char) => `\\${char}`);

const invalid = (field: string, code: string, message: string) =>
  new ApiProblemException(422, 'validation_failed', '1 validation error', [{ field, code, message }]);

export interface DownloadableFile {
  file: FileDto;
  stream: Readable;
}

@Injectable()
export class FilesService {
  private readonly logger = new Logger('FilesService');
  /** Uploads currently receiving bytes on this instance, by user (a cap, not a queue). */
  private readonly stagings = new Map<string, number>();

  constructor(
    @Inject(PRISMA) private readonly prisma: FilesPrisma,
    @Inject(FILES_CONFIG) private readonly config: FilesConfig,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(AttachmentAccess) private readonly attachments: AttachmentAccess,
  ) {}

  async create(actor: Actor, dto: CreateFileDto): Promise<FileDto> {
    const name = sanitizeFileName(dto.name);
    if (name === undefined) throw invalid('name', 'invalid_name', 'name has no usable characters');
    if (dto.sizeBytes > this.config.maxFileBytes)
      throw invalid('sizeBytes', 'too_large', `sizeBytes must be at most ${this.config.maxFileBytes}`);
    const id = uuidv7();
    const row = await withTenant(this.prisma, actor, async (tx) => {
      // Abandoned declarations are retired here, per organization: row-level security gives this service no
      // cross-tenant view, so there is no global sweep. They stop counting against the cap the moment they expire.
      await tx.file.updateMany({
        where: {
          organizationId: actor.organizationId,
          status: 'pending_upload',
          createdAt: { lt: new Date(Date.now() - this.config.pendingUploadTtlMs) },
        },
        data: { status: 'deleted', deletedAt: new Date() },
      });
      // One person's declarations are counted under an advisory lock, so parallel POSTs cannot pass the cap together.
      await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`pending:${actor.organizationId}:${actor.userId}`}, 0))) l`;
      const pending = await tx.file.count({
        where: { organizationId: actor.organizationId, uploadedByUserId: actor.userId, status: 'pending_upload' },
      });
      if (pending >= this.config.maxPendingUploadsPerUser) return undefined;
      return tx.file.create({
        data: {
          id,
          organizationId: actor.organizationId,
          uploadedByUserId: actor.userId,
          // Not attached to anything yet; context_id is NOT NULL, so the file's own id stands in.
          contextType: 'upload',
          contextId: id,
          name,
          mimeType: OCTET_STREAM,
          sizeBytes: BigInt(dto.sizeBytes),
        },
      });
    });
    if (!row)
      throw new ApiProblemException(
        409,
        'too_many_pending_uploads',
        `At most ${this.config.maxPendingUploadsPerUser} uploads can be waiting for their content; finish or delete some.`,
      );
    return toFile(row);
  }

  /** Receives the bytes of a pending file the caller created. Never partially visible; one winner per file. */
  async upload(actor: Actor, fileId: string, source: Readable): Promise<FileDto> {
    const file = await withTenant(this.prisma, actor, (tx) =>
      tx.file.findFirst({
        where: { id: fileId, organizationId: actor.organizationId, uploadedByUserId: actor.userId },
      }),
    );
    if (!file || file.status === 'deleted') throw notFound();
    if (file.status !== 'pending_upload')
      throw new ApiProblemException(409, 'already_uploaded', 'This file already has its content.');

    const sniffer = new TextSniffer();
    let head = Buffer.alloc(0);
    let staged;
    const inFlight = this.stagings.get(actor.userId) ?? 0;
    if (inFlight >= this.config.maxConcurrentUploadsPerUser)
      throw new ApiProblemException(
        429,
        'too_many_concurrent_uploads',
        'Too many uploads are in progress; wait for one to finish.',
        undefined,
        { 'Retry-After': '5', Connection: 'close' },
      );
    this.stagings.set(actor.userId, inFlight + 1);
    try {
      staged = await this.storage.stage(source, {
        maxBytes: this.config.maxFileBytes,
        expectedBytes: Number(file.sizeBytes),
        observe: (chunk) => {
          if (head.length < SNIFF_HEAD_BYTES) head = Buffer.concat([head, chunk]).subarray(0, SNIFF_HEAD_BYTES);
          sniffer.write(chunk);
        },
      });
    } catch (error) {
      if (error instanceof StorageLimitError)
        throw new ApiProblemException(
          413,
          'payload_too_large',
          'The content is larger than the declared size.',
          undefined,
          {
            Connection: 'close',
          },
        );
      if (error instanceof StorageSizeMismatchError)
        throw new ApiProblemException(422, 'size_mismatch', 'The content is smaller than the declared size.');
      if (error instanceof StorageInterruptedError) throw new ApiProblemException(400, 'upload_interrupted');
      throw error;
    } finally {
      const left = (this.stagings.get(actor.userId) ?? 1) - 1;
      if (left <= 0) this.stagings.delete(actor.userId);
      else this.stagings.set(actor.userId, left);
    }

    const mimeType = detectContentType(head, sniffer.isText());
    const key = storageKeyOf(actor.organizationId, file.id, file.currentVersion);
    try {
      const row = await withTenant(this.prisma, actor, async (tx) => {
        // The claim: whichever concurrent upload flips pending_upload first wins; the row lock makes the others wait
        // and then match nothing. Only the winner places bytes under the key.
        const claimed = await tx.file.updateMany({
          where: { id: file.id, organizationId: actor.organizationId, status: 'pending_upload' },
          data: { status: 'available', mimeType, sizeBytes: BigInt(staged.sizeBytes) },
        });
        if (claimed.count === 0)
          throw new ApiProblemException(409, 'already_uploaded', 'This file already has its content.');
        await tx.fileVersion.create({
          data: {
            organizationId: actor.organizationId,
            fileId: file.id,
            versionNumber: file.currentVersion,
            storageKey: key,
            mimeType,
            sizeBytes: BigInt(staged.sizeBytes),
            checksumSha256: staged.sha256,
            uploadedByUserId: actor.userId,
          },
        });
        return tx.file.findFirstOrThrow({ where: { id: file.id, organizationId: actor.organizationId } });
      });
      // Only after the commit: a failed transaction can no longer leave an object behind under the key. If placing
      // the bytes fails now, the committed row is retired so nobody is served a file with no content.
      try {
        await staged.promote(key);
      } catch (error) {
        await this.retire(actor, file.id);
        throw error;
      }
      // A DELETE that committed between our commit and the promote found no object to remove: the bytes just placed
      // belong to a deleted file, so take them away again (a DELETE committing after this read removes them itself).
      const now = await withTenant(this.prisma, actor, (tx) =>
        tx.file.findFirst({
          where: { id: file.id, organizationId: actor.organizationId },
          select: { status: true },
        }),
      );
      if (now?.status === 'deleted') {
        await this.storage.delete(key).catch((error: unknown) => {
          this.logger.error({ event: 'file_object_delete_failed', fileId: file.id, error: (error as Error).message });
        });
        throw notFound();
      }
      return toFile(row);
    } catch (error) {
      await staged.discard();
      throw error;
    }
  }

  private async retire(actor: Actor, fileId: string): Promise<void> {
    await withTenant(this.prisma, actor, (tx) =>
      tx.file.updateMany({
        where: { id: fileId, organizationId: actor.organizationId },
        data: { status: 'deleted', deletedAt: new Date() },
      }),
    ).catch((error: unknown) => {
      this.logger.error({ event: 'file_retire_failed', fileId, error: (error as Error).message });
    });
  }

  async list(actor: Actor, { take, afterId }: Page, q?: string): Promise<FileListDto> {
    const rows = await withTenant(this.prisma, actor, (tx) =>
      tx.file.findMany({
        where: {
          organizationId: actor.organizationId,
          uploadedByUserId: actor.userId,
          status: 'available',
          // Prisma's contains does not escape LIKE wildcards: do it, so q is always a literal substring.
          ...(q ? { name: { contains: escapeLike(q), mode: 'insensitive' as const } } : {}),
          ...(afterId ? { id: { lt: afterId } } : {}),
        },
        orderBy: { id: 'desc' },
        take: take + 1,
      }),
    );
    const page = paginate(rows, take);
    return { data: page.rows.map(toFile), nextCursor: page.nextCursor };
  }

  async get(actor: Actor, fileId: string, req: Request): Promise<FileDto> {
    return toFile(await this.readable(actor, fileId, req));
  }

  async download(actor: Actor, fileId: string, req: Request): Promise<DownloadableFile> {
    const row = await this.readable(actor, fileId, req);
    if (row.status !== 'available') throw notFound();
    const version = await withTenant(this.prisma, actor, (tx) =>
      tx.fileVersion.findFirst({
        where: { fileId, organizationId: actor.organizationId, versionNumber: row.currentVersion },
        select: { storageKey: true },
      }),
    );
    if (!version) throw notFound();
    try {
      const { stream } = await this.storage.get(version.storageKey);
      return { file: toFile(row), stream };
    } catch (error) {
      if (!(error instanceof StorageNotFoundError)) throw error;
      this.logger.error({ event: 'file_object_missing', fileId });
      throw notFound();
    }
  }

  /** Uploader only; the row is kept (status deleted) and the bytes are removed, so nobody can read them again. */
  async remove(actor: Actor, fileId: string): Promise<void> {
    const keys = await withTenant(this.prisma, actor, async (tx) => {
      const claimed = await tx.file.updateMany({
        where: {
          id: fileId,
          organizationId: actor.organizationId,
          uploadedByUserId: actor.userId,
          status: { not: 'deleted' },
        },
        data: { status: 'deleted', deletedAt: new Date() },
      });
      if (claimed.count === 0) throw notFound();
      return tx.fileVersion.findMany({
        where: { fileId, organizationId: actor.organizationId },
        select: { storageKey: true },
      });
    });
    for (const { storageKey } of keys) {
      await this.storage.delete(storageKey).catch((error: unknown) => {
        this.logger.error({ event: 'file_object_delete_failed', fileId, error: (error as Error).message });
      });
    }
  }

  /** The file row if the caller may read it: the uploader, or anyone messaging says can see an attaching message. */
  private async readable(actor: Actor, fileId: string, req: Request) {
    const row = await withTenant(this.prisma, actor, (tx) =>
      tx.file.findFirst({ where: { id: fileId, organizationId: actor.organizationId } }),
    );
    if (!row || row.status === 'deleted') throw notFound();
    if (row.uploadedByUserId === actor.userId) return row;
    if (row.status !== 'available') throw notFound();
    if (!(await this.attachments.isVisibleToCaller(actor.organizationId, fileId, req))) throw notFound();
    return row;
  }
}
