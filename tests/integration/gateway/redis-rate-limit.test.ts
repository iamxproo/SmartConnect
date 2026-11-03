// The gateway's Redis rate-limit store against the real Redis (make infra-up; started by CI's database job).
// Isolation: logical database 15 and a random key prefix per run; every key carries a TTL and the run deletes its
// own keys afterwards. Nothing else in Redis is read or written.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createClient } from '@redis/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEnvFile, REPO_ROOT } from '../../../infrastructure/scripts/lib/db-lib.mjs';
import { RedisRateLimitStore } from '../../../smartconnect-backend/api-gateway/src/rate-limit/stores.js';

const env = { ...parseEnvFile(path.join(REPO_ROOT, '.env')), ...process.env } as Record<string, string | undefined>;
const password = env.REDIS_PASSWORD;
const url = `redis://:${encodeURIComponent(password ?? '')}@127.0.0.1:${env.REDIS_PORT ?? '6379'}/15`;
const prefix = `test:rate-limit:${randomUUID()}:`;

describe('Redis rate-limit store (shared buckets for all gateway instances)', () => {
  let store: RedisRateLimitStore;
  let admin: ReturnType<typeof createClient>;

  beforeAll(async () => {
    if (!password)
      throw new Error('REDIS_PASSWORD is not set in .env (see .env.example); start Redis with make infra-up');
    store = await new RedisRateLimitStore(url, prefix).connect();
    admin = createClient({ url });
    await admin.connect();
  });
  afterAll(async () => {
    for await (const keys of admin.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
      if (keys.length) await admin.del(keys);
    }
    await admin.close();
    await store.close();
  });

  it('allows `limit` requests, then rejects with a retry delay; every key has a TTL', async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await store.consume('bucket-a', 3, 60_000));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results[3]!.retryAfterMs).toBeGreaterThan(0);
    expect(results[3]!.retryAfterMs).toBeLessThanOrEqual(20_000);
    const ttl = await admin.pTTL(`${prefix}bucket-a`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it('is atomic under concurrency: exactly `limit` of many simultaneous requests pass', async () => {
    const results = await Promise.all(Array.from({ length: 25 }, () => store.consume('bucket-b', 5, 60_000)));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });

  it('shares buckets between gateway instances', async () => {
    const second = await new RedisRateLimitStore(url, prefix).connect();
    try {
      expect((await store.consume('bucket-c', 2, 60_000)).allowed).toBe(true);
      expect((await second.consume('bucket-c', 2, 60_000)).allowed).toBe(true);
      expect((await store.consume('bucket-c', 2, 60_000)).allowed).toBe(false);
    } finally {
      await second.close();
    }
  });

  it('fails fast when Redis is unreachable (the gateway then answers 503, fail closed)', async () => {
    const unreachable = new RedisRateLimitStore('redis://127.0.0.1:1/0', prefix);
    unreachable.connect().catch(() => undefined);
    const started = Date.now();
    await expect(unreachable.consume('bucket-d', 1, 1000)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
    await unreachable.close();
  });

  it('answers ping', async () => {
    await expect(store.ping()).resolves.toBeUndefined();
  });
});
