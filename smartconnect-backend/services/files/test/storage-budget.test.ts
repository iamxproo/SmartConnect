// The storage budget: refuses what would pass it, holds uploads in flight, counts what is committed and removed, errs
// on the safe side around a scan, and refuses everything while the usage is unknown.
import { ApiProblemException } from '@smartconnect/backend-kit';
import { describe, expect, it } from 'vitest';
import type { FilesConfig } from '../src/config.js';
import { StorageUnavailableError, type FileStorage } from '../src/storage/file-storage.js';
import { StorageBudget } from '../src/storage/storage-budget.js';

function budgetOf(budgetBytes: number, usage: () => Promise<{ bytes: number; objects: number }>) {
  const storage = { provider: 'fake', usage } as unknown as FileStorage;
  return new StorageBudget(storage, {
    storageBudgetBytes: budgetBytes,
    storageUsageScanIntervalMs: 900_000,
  } as FilesConfig);
}
const statusOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof ApiProblemException ? `${error.getStatus()} ${error.code}` : 'other';
  }
  return 'ok';
};

describe('StorageBudget', () => {
  it('refuses with 507 what would pass the budget, counting uploads in flight', async () => {
    const budget = budgetOf(100, () => Promise.resolve({ bytes: 60, objects: 3 }));
    await budget.refresh();
    expect(statusOf(() => budget.assertRoom(40))).toBe('ok');
    expect(statusOf(() => budget.assertRoom(41))).toBe('507 storage_quota_exceeded');
    const first = budget.reserve(30);
    expect(statusOf(() => budget.reserve(11))).toBe('507 storage_quota_exceeded');
    first.release();
    expect(statusOf(() => budget.assertRoom(40))).toBe('ok');
  });

  it('counts committed uploads, frees released and removed bytes, and commits or releases only once', async () => {
    const budget = budgetOf(100, () => Promise.resolve({ bytes: 0, objects: 0 }));
    await budget.refresh();
    const upload = budget.reserve(70);
    upload.commit();
    upload.release(); // after commit: nothing
    upload.commit(); // twice: nothing
    expect(budget.snapshot()).toMatchObject({ usedBytes: 70, reservedBytes: 0 });
    expect(statusOf(() => budget.assertRoom(31))).toBe('507 storage_quota_exceeded');
    budget.removed(70);
    expect(budget.snapshot()).toMatchObject({ usedBytes: 0 });
    budget.removed(10); // never below zero
    expect(budget.snapshot()).toMatchObject({ usedBytes: 0 });
  });

  it('errs on the safe side during a scan: commits are added on top, removals wait for the next scan', async () => {
    let finish!: (value: { bytes: number; objects: number }) => void;
    const budget = budgetOf(1000, () => new Promise((resolve) => (finish = resolve)));
    const scan = budget.refresh();
    const upload = { r: undefined as unknown };
    // Nothing is known yet: refused (503), never let through.
    expect(statusOf(() => budget.reserve(1))).toBe('503 storage_unavailable');
    finish({ bytes: 100, objects: 1 });
    await scan;
    upload.r = budget.reserve(50);

    let finishSecond!: (value: { bytes: number; objects: number }) => void;
    const budgetUsage = budget as unknown as { storage: { usage: () => Promise<unknown> } };
    budgetUsage.storage.usage = () => new Promise((resolve) => (finishSecond = resolve));
    const second = budget.refresh();
    (upload.r as { commit(): void }).commit(); // committed while the second scan runs
    budget.removed(100); // removed while it runs: not subtracted
    finishSecond({ bytes: 100, objects: 1 }); // the scan saw neither change
    await second;
    expect(budget.snapshot()).toMatchObject({ usedBytes: 150 });
  });

  it('refuses everything while the usage is unknown, and recovers after a successful scan', async () => {
    let failing = true;
    const budget = budgetOf(1000, () =>
      failing
        ? Promise.reject(new StorageUnavailableError('unreachable', 'storage list failed: unreachable'))
        : Promise.resolve({ bytes: 10, objects: 1 }),
    );
    expect(await budget.refresh()).toBe(false);
    expect(statusOf(() => budget.assertRoom(1))).toBe('503 storage_unavailable');
    failing = false;
    expect(await budget.refresh()).toBe(true);
    expect(statusOf(() => budget.assertRoom(990))).toBe('ok');
  });
});
