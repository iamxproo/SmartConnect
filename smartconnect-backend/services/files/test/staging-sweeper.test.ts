import { describe, expect, it, vi } from 'vitest';
import type { FileStorage } from '../src/storage/file-storage.js';
import { STAGING_MAX_AGE_MS, StagingSweeper } from '../src/storage/staging-sweeper.js';

const storageWith = (sweepStaging: FileStorage['sweepStaging']) => ({ sweepStaging }) as unknown as FileStorage;

describe('StagingSweeper', () => {
  it('asks storage to drop staged bytes older than an hour, at startup and on shutdown stops its timer', async () => {
    const sweepStaging = vi.fn().mockResolvedValue(2);
    const sweeper = new StagingSweeper(storageWith(sweepStaging));
    await sweeper.onModuleInit();
    expect(sweepStaging).toHaveBeenCalledWith(STAGING_MAX_AGE_MS);
    sweeper.onApplicationShutdown();
  });

  it('never throws when storage fails', async () => {
    const sweeper = new StagingSweeper(storageWith(vi.fn().mockRejectedValue(new Error('disk'))));
    await expect(sweeper.sweep()).resolves.toBe(0);
  });
});
