import { createClient } from '@redis/client';
import { takeToken, type ConsumeResult, type RateLimitStore } from './rate-limit.js';

const MAX_MEMORY_BUCKETS = 100_000;

/**
 * Per-process buckets for development and tests. NOT shared between gateway instances, which is why production
 * requires REDIS_URL. Bounded: the oldest buckets are dropped beyond MAX_MEMORY_BUCKETS, and expired ones are
 * swept, so a flood of distinct keys cannot exhaust memory.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number; expiresAt: number }>();
  private readonly sweeper = setInterval(() => this.sweep(), 60_000).unref();

  constructor(private readonly now: () => number = Date.now) {}

  consume(key: string, limit: number, windowMs: number): Promise<ConsumeResult> {
    const now = this.now();
    const existing = this.buckets.get(key);
    const { bucket, result } = takeToken(
      existing && existing.expiresAt > now ? existing : undefined,
      now,
      limit,
      windowMs,
    );
    this.buckets.delete(key); // re-insert: Map order = least recently used first
    this.buckets.set(key, { ...bucket, expiresAt: now + windowMs });
    if (this.buckets.size > MAX_MEMORY_BUCKETS) this.buckets.delete(this.buckets.keys().next().value!);
    return Promise.resolve(result);
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    clearInterval(this.sweeper);
    this.buckets.clear();
    return Promise.resolve();
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) if (bucket.expiresAt <= now) this.buckets.delete(key);
  }
}

/**
 * The token-bucket step as one atomic Lua script, timed by the Redis server clock so that gateway instances with
 * skewed clocks share consistent buckets. Mirrors takeToken(). Returns {allowed, remaining, retryAfterMs, resetMs}.
 */
const TOKEN_BUCKET_LUA = `
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local rate = limit / window
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil or ts == nil then
  tokens = limit
else
  tokens = math.min(limit, tokens + math.max(0, now - ts) * rate)
end
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], window)
local retry = 0
if allowed == 0 then retry = math.ceil((1 - tokens) / rate) end
return { allowed, math.floor(tokens), retry, math.ceil((limit - tokens) / rate) }
`;

/** Shared buckets for all gateway instances. Every key has a TTL (the cache Redis evicts volatile-lru). */
export class RedisRateLimitStore implements RateLimitStore {
  private readonly client: ReturnType<typeof createClient>;

  /** `keyPrefix` isolates tests from other users of the same Redis. */
  constructor(
    url: string,
    private readonly keyPrefix = '',
  ) {
    this.client = createClient({
      url,
      // Fail fast instead of queueing while disconnected: the guard turns errors into 503 (fail closed).
      disableOfflineQueue: true,
      commandOptions: { timeout: 1_000 },
      socket: { connectTimeout: 2_000, reconnectStrategy: (retries) => Math.min(retries * 200, 2_000) },
    });
    // Without a listener, a connection error would crash the process; the guard reports failures per request.
    this.client.on('error', () => undefined);
  }

  async connect(): Promise<this> {
    await this.client.connect();
    return this;
  }

  async consume(key: string, limit: number, windowMs: number): Promise<ConsumeResult> {
    const reply = (await this.client.eval(TOKEN_BUCKET_LUA, {
      keys: [`${this.keyPrefix}${key}`],
      arguments: [String(limit), String(windowMs)],
    })) as number[];
    const [allowed, remaining, retryAfterMs, resetMs] = reply;
    return { allowed: allowed === 1, remaining: remaining!, retryAfterMs: retryAfterMs!, resetMs: resetMs! };
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  async close(): Promise<void> {
    if (!this.client.isOpen) return;
    // Connected: finish in-flight commands, then quit. Still (re)connecting: stop immediately, no more retries.
    if (this.client.isReady) await this.client.close();
    else this.client.destroy();
  }
}
