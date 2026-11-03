import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter, type LoggerService } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiProblemException, buildProblem, sendProblem } from './problem-details.js';
import { pathOf, requestIdOf } from './request-context.js';

/**
 * Centralised error handling: every error leaving a route, pipe or guard becomes an RFC 9457 problem response.
 * Unexpected errors are logged with their stack server-side and answered with a generic 500; internal messages
 * never reach the client.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(
    private readonly errorTypeBaseUrl: string,
    private readonly logger: LoggerService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    if (res.headersSent) return;

    if (exception instanceof ApiProblemException) {
      for (const [name, value] of Object.entries(exception.headers ?? {})) res.setHeader(name, value);
      sendProblem(
        res,
        buildProblem(req, this.errorTypeBaseUrl, exception.getStatus(), {
          code: exception.code,
          detail: exception.detail,
          errors: exception.errors,
        }),
      );
      return;
    }

    if (exception instanceof HttpException && exception.getStatus() < 500) {
      // Framework 4xx (e.g. unknown route): generic, input-free detail for the status.
      sendProblem(res, buildProblem(req, this.errorTypeBaseUrl, exception.getStatus()));
      return;
    }

    const error = exception instanceof Error ? exception : new Error(String(exception));
    this.logger.error(
      {
        event: 'unhandled_error',
        requestId: requestIdOf(req),
        method: req.method,
        path: pathOf(req),
        error: error.message,
      },
      error.stack,
      'ProblemDetailsFilter',
    );
    sendProblem(res, buildProblem(req, this.errorTypeBaseUrl, 500));
  }
}
