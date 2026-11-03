// Where file bytes live. The interface is all the service knows (ADR 0013); object storage (ADR 0006) can replace the
// local-filesystem driver later without touching callers. Keys are always server-generated.
import type { Readable } from 'node:stream';

export const FILE_STORAGE = Symbol('FILE_STORAGE');

export interface StageLimits {
  /** Hard ceiling: the transfer is aborted the moment more than this arrives. */
  maxBytes: number;
  /** The size the uploader declared: more or fewer bytes than this is refused. */
  expectedBytes: number;
  /** Called with every chunk, in order (content sniffing). */
  observe?: (chunk: Buffer) => void;
}

/** Bytes fully received, counted and hashed, but not yet readable under any key. */
export interface StagedObject {
  sizeBytes: number;
  sha256: string;
  /** Atomically makes the bytes readable under `key` (replacing nothing the caller did not already own). */
  promote(key: string): Promise<void>;
  /** Drops the bytes; safe to call after promote() and more than once. */
  discard(): Promise<void>;
}

export interface FileStorage {
  /** Receives a stream under the limits. Rejects with StorageLimitError / StorageSizeMismatchError. */
  stage(source: Readable, limits: StageLimits): Promise<StagedObject>;
  /** The object's bytes; rejects with StorageNotFoundError. */
  get(key: string): Promise<{ stream: Readable; sizeBytes: number }>;
  /** Removes the object; a missing object is not an error. */
  delete(key: string): Promise<void>;
  /** Removes leftovers of uploads that never finished (staged bytes older than `olderThanMs`); returns how many. */
  sweepStaging(olderThanMs: number): Promise<number>;
}

export class StorageLimitError extends Error {}
export class StorageSizeMismatchError extends Error {}
export class StorageInterruptedError extends Error {}
export class StorageNotFoundError extends Error {}
export class StorageKeyError extends Error {}

/** `<organization>/<file>/<version>`, built only from ids the service generated. */
export const storageKeyOf = (organizationId: string, fileId: string, version: number): string =>
  `${organizationId}/${fileId}/${version}`;
