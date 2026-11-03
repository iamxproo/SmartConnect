// The HTTP pipeline every SmartConnect NestJS service shares (ADR 0008): request ids, request logs, security
// headers, optional CORS, JSON-only bounded bodies, global validation, RFC 9457 errors and the /api/v1 prefix.
import { RequestMethod, type LoggerService } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, RequestHandler } from 'express';
import helmet from 'helmet';
import { bodyParserErrorHandler, JSON_MEDIA_TYPES, rejectPathEscapes, requireJsonBodies } from './body-handling.js';
import { ProblemDetailsFilter } from './problem-details.filter.js';
import { requestIdMiddleware } from './request-context.js';
import { requestLoggingMiddleware } from './request-logging.js';
import { createValidationPipe } from './validation.js';

export const API_PREFIX = 'api/v1';

type CorsOptions = Exclude<Parameters<NestExpressApplication['enableCors']>[0], undefined>;

/** Unversioned infrastructure probes served outside API_PREFIX. */
export const HEALTH_ROUTES = [
  { path: 'health/live', method: RequestMethod.GET },
  { path: 'health/ready', method: RequestMethod.GET },
];

export interface HttpPipelineOptions {
  logger: LoggerService;
  errorTypeBaseUrl: string;
  /** Express "trust proxy": number of reverse proxies in front of this process. */
  trustProxyHops: number;
  bodyLimitBytes: number;
  /** Production adds CSP upgrade-insecure-requests (locally, Swagger UI is served over plain HTTP). */
  production: boolean;
  /** Browser-facing services only (the gateway). Internal services leave it unset: no CORS headers at all. */
  cors?: CorsOptions;
  /** Extra middleware after CORS and before the body policy (e.g. the gateway's cookie Origin check). */
  beforeBody?: RequestHandler[];
  /** Routes whose body is raw bytes streamed by the handler, exempt from the JSON-only policy (file content). */
  isRawBodyRoute?: (req: Request) => boolean;
  /** Further routes served outside API_PREFIX, in addition to HEALTH_ROUTES. */
  unprefixedRoutes?: { path: string; method: RequestMethod }[];
}

export function configureHttpPipeline(app: NestExpressApplication, options: HttpPipelineOptions): void {
  app.set('trust proxy', options.trustProxyHops);

  // Order matters: request id → logging → security headers → CORS → path check → body policy → JSON parser → parser errors.
  app.use(requestIdMiddleware);
  app.use(requestLoggingMiddleware(options.logger));
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: options.production ? [] : null } },
    }),
  );
  if (options.cors) app.enableCors(options.cors);
  app.use(rejectPathEscapes(options.errorTypeBaseUrl));
  for (const middleware of options.beforeBody ?? []) app.use(middleware);
  app.use(requireJsonBodies(options.errorTypeBaseUrl, options.isRawBodyRoute));
  // A raw-body route is never parsed: the parser would consume (or wait on) the stream the handler pipes.
  app.useBodyParser('json', {
    limit: options.bodyLimitBytes,
    strict: true,
    type: (incoming) => {
      const req = incoming as Request; // an Express request by the time any middleware runs
      return !options.isRawBodyRoute?.(req) && Boolean(req.is(JSON_MEDIA_TYPES));
    },
  });
  app.use(bodyParserErrorHandler(options.errorTypeBaseUrl));

  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new ProblemDetailsFilter(options.errorTypeBaseUrl, options.logger));
  app.setGlobalPrefix(API_PREFIX, { exclude: [...HEALTH_ROUTES, ...(options.unprefixedRoutes ?? [])] });
}

/**
 * Explicit Node HTTP server timeouts (they default to 60 s headers / 300 s whole request, which silently changes
 * with Node versions). Slow-header and slow-body connections are cut instead of holding a socket and, for uploads,
 * a staging file open. `requestTimeoutMs` bounds the whole request, so it must allow the slowest legitimate upload.
 */
export const SERVER_TIMEOUTS = { headersTimeoutMs: 15_000, requestTimeoutMs: 120_000 };
export function configureServerTimeouts(
  app: NestExpressApplication,
  { headersTimeoutMs, requestTimeoutMs } = SERVER_TIMEOUTS,
): void {
  const server = app.getHttpServer();
  server.headersTimeout = headersTimeoutMs;
  server.requestTimeout = requestTimeoutMs;
}
