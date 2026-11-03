// RFC 9457 problem details, as specified in docs/api/conventions.md#errors-rfc-9457-problem-details.
import { HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { pathOf, requestIdOf } from './request-context.js';

export interface FieldError {
  /** Path of the offending field, e.g. `name` or `members[0].email`; `(body)` for the whole body. */
  field: string;
  /** Stable machine-readable reason, e.g. `required`, `too_long`, `unknown_field`. */
  code: string;
  message: string;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  /** Stable, machine-readable identifier clients branch on. */
  code: string;
  detail: string;
  /** Path of the request (no query string). */
  instance: string;
  requestId: string;
  errors?: FieldError[];
}

/** Default code, title and (safe, generic) detail per status. Details never echo request input or internals. */
const DEFAULTS: Record<number, { code: string; title: string; detail: string }> = {
  400: { code: 'bad_request', title: 'Bad request', detail: 'The request could not be understood.' },
  401: { code: 'unauthenticated', title: 'Authentication required', detail: 'Valid credentials are required.' },
  403: { code: 'forbidden', title: 'Forbidden', detail: 'You are not allowed to perform this action.' },
  404: { code: 'not_found', title: 'Not found', detail: 'The requested resource does not exist.' },
  405: { code: 'method_not_allowed', title: 'Method not allowed', detail: 'This method is not supported here.' },
  406: { code: 'not_acceptable', title: 'Not acceptable', detail: 'The requested representation is not available.' },
  409: { code: 'conflict', title: 'Conflict', detail: 'The request conflicts with the current state.' },
  413: { code: 'payload_too_large', title: 'Payload too large', detail: 'The request body exceeds the size limit.' },
  415: {
    code: 'unsupported_media_type',
    title: 'Unsupported media type',
    detail: 'Request bodies must be JSON (Content-Type: application/json).',
  },
  422: { code: 'validation_failed', title: 'Request validation failed', detail: 'One or more fields are invalid.' },
  429: { code: 'rate_limited', title: 'Too many requests', detail: 'Too many requests; retry later.' },
  500: {
    code: 'internal_error',
    title: 'Internal server error',
    detail: 'An unexpected error occurred. Quote the request id when reporting it.',
  },
  502: { code: 'bad_gateway', title: 'Bad gateway', detail: 'An upstream service could not be reached.' },
  503: { code: 'service_unavailable', title: 'Service unavailable', detail: 'The service is temporarily unavailable.' },
  504: { code: 'gateway_timeout', title: 'Gateway timeout', detail: 'An upstream service did not respond in time.' },
};

export function defaultsFor(status: number): { code: string; title: string; detail: string } {
  return (
    DEFAULTS[status] ??
    (status >= 500 ? { ...DEFAULTS[500]!, title: 'Server error' } : { ...DEFAULTS[400]!, title: 'Client error' })
  );
}

/**
 * Throw from anywhere in the request pipeline to produce a specific problem response. `headers` are set on the
 * response (e.g. `WWW-Authenticate`, `Retry-After`).
 */
export class ApiProblemException extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    readonly detail?: string,
    readonly errors?: FieldError[],
    readonly headers?: Readonly<Record<string, string>>,
  ) {
    super(detail ?? code, status);
  }
}

export function buildProblem(
  req: Request,
  errorTypeBaseUrl: string,
  status: number,
  overrides: { code?: string; detail?: string; errors?: FieldError[] } = {},
): ProblemDetails {
  const defaults = defaultsFor(status);
  const code = overrides.code ?? defaults.code;
  return {
    type: `${errorTypeBaseUrl}${code.replaceAll('_', '-')}`,
    title: defaults.title,
    status,
    code,
    detail: overrides.detail ?? defaults.detail,
    instance: pathOf(req),
    requestId: requestIdOf(req),
    ...(overrides.errors ? { errors: overrides.errors } : {}),
  };
}

export function sendProblem(res: Response, problem: ProblemDetails): void {
  res.status(problem.status).type('application/problem+json').json(problem);
}
