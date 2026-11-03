import type { LoggerService } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { pathOf, requestIdOf } from './request-context.js';

export interface RequestLogEntry {
  event: 'http_request';
  requestId: string;
  method: string;
  /** Path only: query strings, headers and bodies are never logged (they can carry tokens or personal data). */
  path: string;
  status: number;
  durationMs: number;
  /** The client disconnected before the response finished. */
  aborted: boolean;
}

/** One structured log line per request, written when the response finishes (or the client aborts). */
export function requestLoggingMiddleware(logger: LoggerService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = process.hrtime.bigint();
    const path = pathOf(req);
    let logged = false;

    const log = () => {
      if (logged) return;
      logged = true;
      const entry: RequestLogEntry = {
        event: 'http_request',
        requestId: requestIdOf(req),
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100,
        aborted: !res.writableFinished,
      };
      if (res.statusCode >= 500) logger.error(entry, undefined, 'HTTP');
      else if (res.statusCode >= 400) logger.warn(entry, 'HTTP');
      // Orchestrator probes hit health endpoints every few seconds: keep them out of the default log level.
      else if (path.startsWith('/health/')) logger.debug?.(entry, 'HTTP');
      else logger.log(entry, 'HTTP');
    };

    res.once('finish', log);
    res.once('close', log);
    next();
  };
}
