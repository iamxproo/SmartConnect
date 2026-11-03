// File rules (ADR 0013). Metadata lives in PostgreSQL under row-level security; bytes live behind FileStorage (the
// local directory or Cloudflare R2, whichever is configured: nothing here depends on which). Read access: the
// uploader, or whoever messaging says can see a message attaching the file. A file nobody may read is a 404, never a
// 403, so ids reveal nothing. The database is never held open while bytes move. Every upload fits the storage
// budget first (storage-budget.ts); a storage outage is a 503, never a 500 or a half-made file.
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
  StorageUnavailableError,
  type FileStorage,
} from '../storage/file-storage.js';
import { StorageBudget, storageUnavailable } from '../storage/storage-budget.js';
import { AttachmentAccess } from './attachment-access.js';
import { detectContentType, OCTET_STREAM, SNIFF_HEAD_BYTES, TextSniffer } from './content-type.js';
import type { CreateFileDto, FileDto, FileListDto } from './dto.js';
import { contentDisposition, sanitizeFileName } from './names.js';
import { INLINE_TYPES } from './content-type.js';

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

/** How a file's bytes are served to a browser; the same for the streamed download and a signed link. */
export const servedType = (file: { mimeType: string }) =>
  file.mimeType === 'text/plain' ? 'text/plain; charset=utf-8' : file.mimeType;
export const servedDisposition = (file: { mimeType: string; name: string }) =>
  contentDisposition(INLINE_TYPES.has(file.mimeType) ? 'inline' : 'attachment', file.name);

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
    @Inject(StorageBudget) private readonly budget: StorageBudget,
  ) {}

  /** A storage failure, logged by category only (never a URL, key material or provider message), as a 503. */
  private unavailable(operation: string, fileId: string, error: StorageUnavailableError) {
    this.logger.error({ event: 'storage_failed', operation, category: error.category, fileId });
    return storageUnavailable();
  }

  async create(actor: Actor, dto: CreateFileDto): Promise<FileDto> {
    const name = sanitizeFileName(dto.name);
    if (name === undefined) throw invalid('name', 'invalid_name', 'name has no usable characters');
    if (dto.sizeBytes > this.config.maxFileBytes)
      throw invalid('sizeBytes', 'too_large', `sizeBytes must be at most ${this.config.maxFileBytes}`);
    // Early and cheap: a file that cannot fit is refused before anything is declared (upload() checks again, holding
    // the bytes for the transfer).
    this.budget.assertRoom(dto.sizeBytes);
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
    const reservation = this.budget.reserve(Number(file.sizeBytes));
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
      if (!staged) reservation.release();
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
        await staged.promote(key, { contentType: mimeType });
        reservation.commit();
      } catch (error) {
        await this.retire(actor, file.id);
        if (error instanceof StorageUnavailableError) throw this.unavailable('put', file.id, error);
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
        await this.storage.delete(key).then(
          () => this.budget.removed(staged.sizeBytes),
          (error: unknown) => {
            this.logger.error({ event: 'file_object_delete_failed', fileId: file.id, error: (error as Error).message });
          },
        );
        throw notFound();
      }
      return toFile(row);
    } catch (error) {
      reservation.release(); // a no-op once committed
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
      if (error instanceof StorageUnavailableError) throw this.unavailable('get', fileId, error);
      if (!(error instanceof StorageNotFoundError)) throw error;
      this.logger.error({ event: 'file_object_missing', fileId });
      throw notFound();
    }
  }

  /**
   * A short-lived link to the bytes in object storage, for exactly the people download() serves (the same check,
   * first). The link is signed for this one object and these response headers, and expires after
   * FILES_SIGNED_URL_TTL_SECONDS; the local driver has none (404 signed_urls_unavailable).
   */
  async downloadUrl(actor: Actor, fileId: string, req: Request): Promise<{ url: string; expiresAt: string }> {
    if (!this.storage.signedReadUrl)
      throw new ApiProblemException(404, 'signed_urls_unavailable', 'This server serves file content directly only.');
    const row = await this.readable(actor, fileId, req);
    if (row.status !== 'available') throw notFound();
    const version = await withTenant(this.prisma, actor, (tx) =>
      tx.fileVersion.findFirst({
        where: { fileId, organizationId: actor.organizationId, versionNumber: row.currentVersion },
        select: { storageKey: true },
      }),
    );
    if (!version) throw notFound();
    const expiresInSeconds = this.config.signedUrlTtlSeconds;
    const url = this.storage.signedReadUrl(version.storageKey, {
      expiresInSeconds,
      contentType: servedType(row),
      contentDisposition: servedDisposition(row),
    });
    return { url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString() };
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
        select: { storageKey: true, sizeBytes: true },
      });
    });
    for (const { storageKey, sizeBytes } of keys) {
      await this.storage.delete(storageKey).then(
        () => this.budget.removed(Number(sizeBytes)),
        (error: unknown) => {
          // The file is gone for everyone already; the bytes stay until removed by hand (and keep counting).
          const category = error instanceof StorageUnavailableError ? error.category : 'unexpected';
          this.logger.error({ event: 'file_object_delete_failed', fileId, category });
        },
      );
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
