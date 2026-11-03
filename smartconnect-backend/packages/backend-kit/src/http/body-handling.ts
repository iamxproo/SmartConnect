// Request body safety: JSON only, bounded size, and parser failures turned into problem responses instead of
// Express's default HTML error pages.
import type { NextFunction, Request, Response } from 'express';
import { buildProblem, sendProblem } from './problem-details.js';

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Accepted (and parsed) request media types: JSON, including structured-syntax types like merge-patch+json. */
export const JSON_MEDIA_TYPES = ['application/json', 'application/*+json'];

function hasBody(req: Request): boolean {
  const length = req.headers['content-length'];
  return req.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
}

/**
 * The one route whose body is raw file bytes (ADR 0013): PUT /api/v1/orgs/{org}/files/{file}/content. Exactly this
 * shape, so no other route can opt out of the JSON-only policy by accident.
 */
const FILE_CONTENT_PATH = /^\/api\/v1\/orgs\/[^/]+\/files\/[^/]+\/content\/?$/;
export const isFileContentUpload = (req: Request): boolean => req.method === 'PUT' && FILE_CONTENT_PATH.test(req.path);

/**
 * Path escapes: encoded dots or separators (%2e, %2f, %5c) and literal "." / ".." segments. Proxies and URL parsers
 * collapse them, so a request could be routed (and rate limited) as one path yet forwarded as another. No SmartConnect
 * route needs one, so they are refused with 400 before any routing. Looks at the raw request target, not req.path.
 */
const ENCODED_ESCAPE = /%(2e|2f|5c)/i;
export function hasPathEscape(originalUrl: string): boolean {
  const queryAt = originalUrl.indexOf('?');
  const path = queryAt === -1 ? originalUrl : originalUrl.slice(0, queryAt);
  if (ENCODED_ESCAPE.test(path) || path.includes('\\')) return true;
  return path.split('/').some((segment) => segment === '.' || segment === '..');
}

export function rejectPathEscapes(errorTypeBaseUrl: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!hasPathEscape(req.originalUrl)) {
      next();
      return;
    }
    sendProblem(
      res,
      buildProblem(req, errorTypeBaseUrl, 400, {
        code: 'invalid_path',
        detail: 'The request path contains encoded or relative segments.',
      }),
    );
  };
}

/**
 * 415 for bodies that are not JSON (`application/json` or `application/*+json`, e.g. merge-patch+json).
 * `isRawBodyRoute` exempts a route whose body is streamed by its handler (the parser is never applied to it either:
 * it only accepts JSON media types).
 */
export function requireJsonBodies(errorTypeBaseUrl: string, isRawBodyRoute?: (req: Request) => boolean) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isRawBodyRoute?.(req)) {
      next();
      return;
    }
    if (METHODS_WITH_BODY.has(req.method) && hasBody(req) && !req.is(JSON_MEDIA_TYPES)) {
      sendProblem(res, buildProblem(req, errorTypeBaseUrl, 415));
      return;
    }
    next();
  };
}

interface BodyParserError extends Error {
  type?: string;
  status?: number;
}

/** Express error middleware placed right after the JSON parser. */
export function bodyParserErrorHandler(errorTypeBaseUrl: string) {
  return (error: BodyParserError, req: Request, res: Response, next: NextFunction): void => {
    switch (error.type) {
      case 'entity.parse.failed':
        sendProblem(
          res,
          buildProblem(req, errorTypeBaseUrl, 400, {
            code: 'malformed_json',
            detail: 'The request body is not valid JSON.',
          }),
        );
        return;
      case 'entity.too.large':
        sendProblem(res, buildProblem(req, errorTypeBaseUrl, 413));
        return;
      case 'encoding.unsupported':
      case 'charset.unsupported':
        sendProblem(
          res,
          buildProblem(req, errorTypeBaseUrl, 415, { detail: 'Only UTF-8 encoded JSON request bodies are supported.' }),
        );
        return;
      case 'request.aborted':
      case 'request.size.invalid':
        sendProblem(res, buildProblem(req, errorTypeBaseUrl, 400));
        return;
      default:
        next(error);
    }
  };
}
