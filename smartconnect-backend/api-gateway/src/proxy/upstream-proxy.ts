// Forwards a request to the owning service. Routing only: no business logic, no data. The gateway decides
// WHICH requests may pass (authentication, rate limits); the service decides everything else.
import http from 'node:http';
import https from 'node:https';
import { pipeline, Transform } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiProblemException, REQUEST_ID_HEADER, requestIdOf } from '@smartconnect/backend-kit';
import type { Request, Response } from 'express';
import { GATEWAY_CONFIG, type GatewayConfig } from '../config/config.js';

export type Upstream = keyof GatewayConfig['upstreams'];

/**
 * Request headers passed upstream. An allowlist, so client-supplied identity or routing headers (X-User-Id,
 * X-Organization-Id, X-Forwarded-*, Host, …) never reach a service: services derive the caller from the verified
 * access token only.
 */
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'authorization',
  'content-type',
  'idempotency-key',
  'if-match',
  'if-none-match',
  'traceparent',
  'tracestate',
  'user-agent',
];

/** Response headers passed back to the client. The gateway sets its own CORS, security and request-id headers. */
const FORWARDED_RESPONSE_HEADERS = [
  'cache-control',
  'content-language',
  'content-type',
  'etag',
  'location',
  'retry-after',
  'www-authenticate',
];

/**
 * File-content routes only. Request headers are an even shorter allowlist: the body is raw bytes, so the type is
 * always rewritten to application/octet-stream and the length is checked here before a byte moves.
 */
const STREAMED_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'authorization',
  'traceparent',
  'tracestate',
  'user-agent',
];

/** Download headers that make the bytes safe to hand to a browser; the files service decides their values. */
const STREAMED_RESPONSE_HEADERS = [
  'cache-control',
  'content-disposition',
  'content-language',
  'content-length',
  'content-security-policy',
  'content-type',
  'etag',
  'retry-after',
  'www-authenticate',
  'x-content-type-options',
];

/**
 * Any path under .../files/{id}/content. forward() buffers and filters headers, which is wrong for file bytes, so it
 * refuses these outright (defence in depth: the routing layer is what normally sends them to stream()).
 */
const FILE_CONTENT_PATH = /\/files\/[^/]+\/content\/?$/i;

export interface ForwardOptions {
  /** Cookies (by name) the upstream may receive; every other cookie is dropped. */
  cookies?: readonly string[];
}

function filterCookies(header: string | undefined, allowed: readonly string[]): string | undefined {
  if (!header || allowed.length === 0) return undefined;
  const kept = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => allowed.includes(part.slice(0, part.indexOf('='))));
  return kept.length ? kept.join('; ') : undefined;
}

@Injectable()
export class UpstreamProxy {
  private readonly logger = new Logger('UpstreamProxy');

  constructor(@Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig) {}

  async forward(upstream: Upstream, req: Request, res: Response, options: ForwardOptions = {}): Promise<void> {
    // Only the path and query of the original request are used, never its authority: a request-target such as
    // "//evil.example/x" cannot redirect the call to another host.
    const { pathname, search } = new URL(req.originalUrl, 'http://gateway.invalid');
    if (FILE_CONTENT_PATH.test(pathname)) throw new ApiProblemException(400, 'invalid_path');
    const target = `${this.config.upstreams[upstream]}${pathname}${search}`;

    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.get(name);
      if (value !== undefined) headers.set(name, value);
    }
    const cookie = filterCookies(req.get('cookie'), options.cookies ?? []);
    if (cookie) headers.set('cookie', cookie);
    headers.set(REQUEST_ID_HEADER, requestIdOf(req));
    // The client address as resolved by the gateway's own trust-proxy setting, replacing anything the client sent.
    if (req.ip) headers.set('x-forwarded-for', req.ip);
    headers.set('x-forwarded-proto', req.protocol);

    const hasBody = req.body !== undefined && !['GET', 'HEAD'].includes(req.method);
    let status: number;
    let responseHeaders: Headers;
    let body: Buffer;
    try {
      const upstreamResponse = await fetch(target, {
        method: req.method,
        headers,
        body: hasBody ? JSON.stringify(req.body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.config.upstreamTimeoutMs),
      });
      status = upstreamResponse.status;
      responseHeaders = upstreamResponse.headers;
      body = Buffer.from(await upstreamResponse.arrayBuffer());
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
      this.logger.warn({
        event: 'upstream_failed',
        upstream,
        requestId: requestIdOf(req),
        error: timedOut ? 'timeout' : (error as Error).message,
      });
      throw timedOut ? new ApiProblemException(504, 'gateway_timeout') : new ApiProblemException(502, 'bad_gateway');
    }

    res.status(status);
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = responseHeaders.get(name);
      if (value !== null) res.setHeader(name, value);
    }
    const setCookies = responseHeaders.getSetCookie();
    if (setCookies.length) res.setHeader('set-cookie', setCookies);
    res.end(body);
  }

  /**
   * Pipes a raw-bytes request to the upstream and its response back, never holding a whole file in memory. Used for
   * exactly the two file-content routes (ADR 0013); every other route goes through forward() and stays JSON only.
   * An upload must declare its length, and one above `maxBytes` is refused before any byte is read.
   */
  stream(upstream: Upstream, req: Request, res: Response, { maxBytes }: { maxBytes: number }): Promise<void> {
    const { pathname, search } = new URL(req.originalUrl, 'http://gateway.invalid');
    const target = new URL(`${this.config.upstreams[upstream]}${pathname}${search}`);
    const hasBody = req.method === 'PUT';

    const headers: Record<string, string> = {};
    for (const name of STREAMED_REQUEST_HEADERS) {
      const value = req.get(name);
      if (value !== undefined) headers[name] = value;
    }
    headers[REQUEST_ID_HEADER] = requestIdOf(req);
    if (req.ip) headers['x-forwarded-for'] = req.ip;
    headers['x-forwarded-proto'] = req.protocol;
    if (hasBody) {
      const declared = req.get('content-length');
      if (declared === undefined || !/^\d+$/.test(declared))
        throw new ApiProblemException(411, 'length_required', 'Uploads must declare their Content-Length.');
      if (!req.is('application/octet-stream'))
        throw new ApiProblemException(415, 'unsupported_media_type', 'The content must be application/octet-stream.');
      if (Number(declared) > maxBytes) throw new ApiProblemException(413, 'payload_too_large');
      headers['content-length'] = declared;
      headers['content-type'] = 'application/octet-stream';
    }

    return new Promise<void>((resolve, reject) => {
      let responded = false;
      const upstreamRequest = (target.protocol === 'https:' ? https : http).request(target, {
        method: req.method,
        headers,
        timeout: this.config.upstreamTimeoutMs,
      });
      const guard = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          sent += chunk.length;
          callback(sent > maxBytes ? new Error('body exceeds the limit') : null, chunk);
        },
      });
      let sent = 0;

      const refuse = (error: unknown, timedOut: boolean): void => {
        if (responded) return; // the response is already on its way (or finished); a late write error is moot
        responded = true;
        this.logger.warn({
          event: 'upstream_failed',
          upstream,
          requestId: requestIdOf(req),
          error: timedOut ? 'timeout' : (error as Error).message,
        });
        req.unpipe();
        req.resume();
        reject(
          timedOut ? new ApiProblemException(504, 'gateway_timeout') : new ApiProblemException(502, 'bad_gateway'),
        );
      };
      upstreamRequest.on('timeout', () => {
        upstreamRequest.destroy();
        refuse(new Error('timeout'), true);
      });
      upstreamRequest.on('error', (error) => refuse(error, false));
      guard.on('error', () => {
        upstreamRequest.destroy();
        if (!responded) {
          responded = true;
          res.destroy(); // a body longer than it declared: nothing sensible to answer
          resolve();
        }
      });
      // The client went away (or the response finished): stop the upstream work.
      res.on('close', () => upstreamRequest.destroy());

      upstreamRequest.on('response', (upstreamResponse) => {
        responded = true;
        if (hasBody) {
          // The upstream answered before reading everything (e.g. it refused the upload): stop sending, drain.
          req.unpipe(guard);
          req.resume();
        }
        res.status(upstreamResponse.statusCode ?? 502);
        for (const name of STREAMED_RESPONSE_HEADERS) {
          const value = upstreamResponse.headers[name];
          if (value !== undefined) res.setHeader(name, value);
        }
        pipeline(upstreamResponse, res, () => resolve());
      });

      if (hasBody) {
        req.pipe(guard).pipe(upstreamRequest);
        req.once('error', () => upstreamRequest.destroy());
      } else {
        upstreamRequest.end();
      }
    });
  }
}
