// The application's storage budget (FILES_STORAGE_BUDGET_BYTES, default 10 GB: Cloudflare R2's free storage). It
// counts what the storage itself holds (FileStorage.usage(): for R2 a bucket listing, i.e. what R2 bills), scanned at
// startup and every FILES_STORAGE_USAGE_SCAN_SECONDS, plus what this process stores or deletes in between. An upload
// is refused before a byte moves if the stored bytes, the uploads in flight and its own size would pass the budget.
//
// It errs on the safe side: uploads finished during a scan are counted on top of it (they may be counted twice
// until the next scan); deletions during a scan are not subtracted until the next one; and while the usage is unknown
// (the first scan failed) uploads are refused, never let through. It is a guard inside this application, NOT a
// billing limit at the provider: other writers to the bucket, other instances' uploads between scans, and R2's own
// accounting are outside it.
import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ApiProblemException } from '@smartconnect/backend-kit';
import { FILES_CONFIG, type FilesConfig } from '../config.js';
import { FILE_STORAGE, StorageUnavailableError, type FileStorage } from './file-storage.js';

/** While the usage is unknown, a failed scan is retried this often. */
export const USAGE_RETRY_MS = 60_000;

export interface Reservation {
  /** The bytes are stored now: they count as used. */
  commit(): void;
  /** The upload did not happen: the bytes are free again. A no-op after commit(). */
  release(): void;
}

export const storageFull = (budgetBytes: number) =>
  new ApiProblemException(
    507,
    'storage_quota_exceeded',
    `File storage has reached its limit (${budgetBytes} bytes). Delete files you no longer need, or ask an administrator.`,
  );

export const storageUnavailable = () =>
  new ApiProblemException(
    503,
    'storage_unavailable',
    'File storage is unavailable right now. Try again shortly.',
    undefined,
    {
      'Retry-After': '30',
    },
  );

@Injectable()
export class StorageBudget implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('StorageBudget');
  private used: number | undefined;
  private reserved = 0;
  /** Set while a scan runs: what was committed meanwhile, added on top of the scan's result. */
  private scan: { committed: number } | undefined;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(FILES_CONFIG) private readonly config: FilesConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.schedule();
  }

  onApplicationShutdown(): void {
    this.closed = true;
    clearTimeout(this.timer);
  }

  private schedule(): void {
    if (this.closed) return;
    const delay = this.used === undefined ? USAGE_RETRY_MS : this.config.storageUsageScanIntervalMs;
    this.timer = setTimeout(() => void this.refresh().then(() => this.schedule()), delay);
    this.timer.unref();
  }

  /** Re-counts the stored bytes. Never throws; false when the storage could not be listed. */
  async refresh(): Promise<boolean> {
    const scan = { committed: 0 };
    this.scan = scan;
    try {
      const { bytes, objects } = await this.storage.usage();
      this.used = bytes + scan.committed;
      this.logger.log({
        event: 'storage_usage',
        provider: this.storage.provider,
        objects,
        usedBytes: this.used,
        budgetBytes: this.config.storageBudgetBytes,
      });
      return true;
    } catch (error) {
      const category = error instanceof StorageUnavailableError ? error.category : 'unexpected';
      this.logger.error({ event: 'storage_usage_scan_failed', provider: this.storage.provider, category });
      return false;
    } finally {
      if (this.scan === scan) this.scan = undefined;
    }
  }

  /** Throws 507 if `bytes` more would pass the budget, 503 while the usage is unknown. */
  assertRoom(bytes: number): void {
    if (this.used === undefined) throw storageUnavailable();
    if (this.used + this.reserved + bytes > this.config.storageBudgetBytes)
      throw storageFull(this.config.storageBudgetBytes);
  }

  /** Holds `bytes` for an upload in flight (assertRoom first), until it is committed or released. */
  reserve(bytes: number): Reservation {
    this.assertRoom(bytes);
    this.reserved += bytes;
    let open = true;
    return {
      commit: () => {
        if (!open) return;
        open = false;
        this.reserved -= bytes;
        this.used = (this.used ?? 0) + bytes;
        if (this.scan) this.scan.committed += bytes;
      },
      release: () => {
        if (!open) return;
        open = false;
        this.reserved -= bytes;
      },
    };
  }

  /** Bytes deleted from the storage. Ignored during a scan (it may already have missed them): safe side. */
  removed(bytes: number): void {
    if (this.used === undefined || this.scan) return;
    this.used = Math.max(0, this.used - bytes);
  }

  snapshot() {
    return { budgetBytes: this.config.storageBudgetBytes, usedBytes: this.used, reservedBytes: this.reserved };
  }
}
