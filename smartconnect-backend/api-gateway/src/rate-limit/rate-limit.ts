// Token-bucket rate limiting at the gateway (docs/api/conventions.md#rate-limiting, ADR 0009). Each rule is a
// bucket of `limit` tokens refilled evenly over `windowSeconds`, keyed by client IP, authenticated user or a
// request-body field (the login email). Keys are hashed, so Redis never holds IPs or email addresses.
import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiProblemException, principalOf, requestIdOf } from '@smartconnect/backend-kit';
import type { Request, Response } from 'express';

export type RateLimitKey = 'ip' | 'user' | { bodyField: string };

export interface RateLimitRule {
  /** Bucket namespace, unique per rule (e.g. "login-ip"). */
  name: string;
  key: RateLimitKey;
  limit: number;
  windowSeconds: number;
}

export interface ConsumeResult {
  allowed: boolean;
  /** Whole tokens left after this request. */
  remaining: number;
  /** When rejected: time until one token is available. */
  retryAfterMs: number;
  /** Time until the bucket is full again. */
  resetMs: number;
}

export interface RateLimitStore {
  consume(key: string, limit: number, windowMs: number): Promise<ConsumeResult>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');
export const RATE_LIMIT_RULES = 'smartconnect:rateLimit';

/** Applies the given buckets to a route; every bucket must have a token for the request to proceed. */
export const RateLimit = (...rules: RateLimitRule[]) => SetMetadata(RATE_LIMIT_RULES, rules);

/** Pure token-bucket step, shared by the memory store and mirrored by the Redis Lua script. */
export function takeToken(
  bucket: { tokens: number; updatedAt: number } | undefined,
  now: number,
  limit: number,
  windowMs: number,
): { bucket: { tokens: number; updatedAt: number }; result: ConsumeResult } {
  const refillPerMs = limit / windowMs;
  const elapsed = bucket ? Math.max(0, now - bucket.updatedAt) : 0;
  let tokens = bucket ? Math.min(limit, bucket.tokens + elapsed * refillPerMs) : limit;
  const allowed = tokens >= 1;
  if (allowed) tokens -= 1;
  return {
    bucket: { tokens, updatedAt: now },
    result: {
      allowed,
      remaining: Math.floor(tokens),
      retryAfterMs: allowed ? 0 : Math.ceil((1 - tokens) / refillPerMs),
      resetMs: Math.ceil((limit - tokens) / refillPerMs),
    },
  };
}

function subjectOf(key: RateLimitKey, req: Request): string | undefined {
  if (key === 'ip') return req.ip;
  if (key === 'user') return principalOf(req)?.userId;
  const value = (req.body as Record<string, unknown> | undefined)?.[key.bodyField];
  // Same normalisation as the identity service's email lookup, so "A@x.io " and "a@x.io" share a bucket. A missing
  // field is skipped: the request then fails validation upstream without reaching the credential check.
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined;
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);

function setHeaders(res: Response, rule: RateLimitRule, result: ConsumeResult): void {
  res.setHeader('RateLimit-Limit', String(rule.limit));
  res.setHeader('RateLimit-Remaining', String(result.remaining));
  res.setHeader('RateLimit-Reset', String(Math.ceil(result.resetMs / 1000)));
}

/**
 * Global guard, registered after AccessTokenGuard so "user" buckets see the verified principal. Fails CLOSED: if
 * the store is unreachable, rate-limited routes answer 503 rather than run without brute-force protection.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger('RateLimit');

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rules = this.reflector.getAllAndOverride<RateLimitRule[] | undefined>(RATE_LIMIT_RULES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!rules?.length) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    let tightest: { rule: RateLimitRule; result: ConsumeResult } | undefined;
    for (const rule of rules) {
      const subject = subjectOf(rule.key, req);
      if (subject === undefined) continue;
      let result: ConsumeResult;
      try {
        result = await this.store.consume(`rl:${rule.name}:${digest(subject)}`, rule.limit, rule.windowSeconds * 1000);
      } catch (error) {
        this.logger.error({
          event: 'rate_limit_store_unavailable',
          requestId: requestIdOf(req),
          error: (error as Error).message,
        });
        throw new ApiProblemException(503, 'rate_limiter_unavailable', 'The service is temporarily unavailable.');
      }
      if (!result.allowed) {
        setHeaders(res, rule, result);
        throw new ApiProblemException(429, 'rate_limited', 'Too many requests; retry later.', undefined, {
          'Retry-After': String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))),
        });
      }
      if (!tightest || result.remaining < tightest.result.remaining) tightest = { rule, result };
    }
    if (tightest) setHeaders(res, tightest.rule, tightest.result);
    return true;
  }
}
