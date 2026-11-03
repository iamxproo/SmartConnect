// Where file bytes live. The interface is all the service knows (ADR 0013): the local-filesystem driver (development,
// tests) and the Cloudflare R2 driver (production, ADR 0006) implement it, and nothing above it knows which is in use.
// Keys are always server-generated and validated by every driver before use.
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

/** What a driver may record with an object; the database stays the source of truth for metadata. */
export interface ObjectMetadata {
  /** The content type detected from the bytes. */
  contentType?: string;
}

/** Bytes fully received, counted and hashed, but not yet readable under any key. */
export interface StagedObject {
  sizeBytes: number;
  sha256: string;
  /** Makes the bytes readable under `key` (replacing nothing the caller did not already own). */
  promote(key: string, metadata?: ObjectMetadata): Promise<void>;
  /** Drops the bytes; safe to call after promote() and more than once. */
  discard(): Promise<void>;
}

/** A link to read one object without the service's credentials, for a short time. */
export interface SignedReadOptions {
  expiresInSeconds: number;
  /** Response headers the provider must send with the bytes. */
  contentType: string;
  contentDisposition: string;
}

export interface FileStorage {
  /** Short provider name for logs and health ("local", "r2"). */
  readonly provider: string;
  /** Receives a stream under the limits. Rejects with StorageLimitError / StorageSizeMismatchError. */
  stage(source: Readable, limits: StageLimits): Promise<StagedObject>;
  /** The object's bytes; rejects with StorageNotFoundError. */
  get(key: string): Promise<{ stream: Readable; sizeBytes: number }>;
  /** The object's size if it exists, undefined if it does not. */
  head(key: string): Promise<{ sizeBytes: number } | undefined>;
  /** Removes the object; a missing object is not an error. */
  delete(key: string): Promise<void>;
  /** Bytes and objects stored, as the storage itself counts them (the storage budget is based on this). */
  usage(): Promise<{ bytes: number; objects: number }>;
  /** Removes leftovers of uploads that never finished (staged bytes older than `olderThanMs`); returns how many. */
  sweepStaging(olderThanMs: number): Promise<number>;
  /** Drivers that can hand out short-lived read links (object storage); the local driver cannot. */
  signedReadUrl?(key: string, options: SignedReadOptions): string;
}

export class StorageLimitError extends Error {}
export class StorageSizeMismatchError extends Error {}
export class StorageInterruptedError extends Error {}
export class StorageNotFoundError extends Error {}
export class StorageKeyError extends Error {}
/**
 * The storage could not do what was asked (outage, timeout, refused credentials, an unexpected answer). `category`
 * is safe to log; the message never carries credentials, signatures or signed links.
 */
export class StorageUnavailableError extends Error {
  constructor(
    readonly category: 'unreachable' | 'timeout' | 'credentials' | 'provider_error' | 'unexpected_response',
    message: string,
  ) {
    super(message);
  }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** `<organization>/<file>/<version>`: exactly the shape storageKeyOf builds, nothing else (no `..`, no `/`). */
const KEY = new RegExp(`^${UUID}/${UUID}/[1-9][0-9]{0,8}$`);

/** `<organization>/<file>/<version>`, built only from ids the service generated. */
export const storageKeyOf = (organizationId: string, fileId: string, version: number): string =>
  `${organizationId}/${fileId}/${version}`;

/** Every driver calls this before using a key: anything not shaped by storageKeyOf is refused. */
export function assertStorageKey(key: string): string {
  if (!KEY.test(key)) throw new StorageKeyError('invalid storage key');
  return key;
}

export const isStorageKey = (key: string): boolean => KEY.test(key);
