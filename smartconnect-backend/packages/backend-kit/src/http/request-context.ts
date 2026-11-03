import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Inbound request ids are accepted only when they are a safe token (correlation with an upstream proxy or a
 * client); anything else (too short or long, spaces, control characters) is replaced, so a caller cannot
 * inject content into logs or response headers.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();
const requestIds = new WeakMap<Request, string>();

/** Request id of the request being handled; available to any code running inside it (e.g. future service calls). */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function requestIdOf(req: Request): string {
  return requestIds.get(req) ?? 'unknown';
}

/**
 * Path as the client sent it, without the query string (which can carry tokens or personal data). Unlike
 * `req.path`, it is not relative to a router mount point, so it includes the global /api/v1 prefix.
 */
export function pathOf(req: Request): string {
  const url = req.originalUrl;
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

export function resolveRequestId(inbound: string | undefined): string {
  return inbound !== undefined && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
}

/** First middleware: assigns the request id, echoes it on the response and opens the async context. */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = resolveRequestId(req.get(REQUEST_ID_HEADER));
  requestIds.set(req, requestId);
  res.setHeader(REQUEST_ID_HEADER, requestId);
  storage.run({ requestId }, next);
}
