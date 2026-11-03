// Removes staged upload bytes (<storage>/.tmp) that no live request owns any more: a crash or kill mid-upload leaves
// them behind. Runs once at startup and then hourly. A staging file belongs to an in-flight upload for at most the
// server's request timeout (2 minutes), so anything older than an hour is an orphan.
// Abandoned pending_upload rows are retired lazily per organization instead (FilesService.create): row-level
// security gives this service no cross-tenant view to sweep.
import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { FILE_STORAGE, type FileStorage } from './file-storage.js';

export const STAGING_MAX_AGE_MS = 60 * 60 * 1000;
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class StagingSweeper implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('StagingSweeper');
  private timer: NodeJS.Timeout | undefined;

  constructor(@Inject(FILE_STORAGE) private readonly storage: FileStorage) {}

  async onModuleInit(): Promise<void> {
    await this.sweep();
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** Never throws: housekeeping must not take the service down. Returns how many orphans were removed. */
  async sweep(maxAgeMs = STAGING_MAX_AGE_MS): Promise<number> {
    try {
      const removed = await this.storage.sweepStaging(maxAgeMs);
      if (removed > 0) this.logger.log({ event: 'staging_swept', removed });
      return removed;
    } catch (error) {
      this.logger.error({ event: 'staging_sweep_failed', error: (error as Error).message });
      return 0;
    }
  }
}
