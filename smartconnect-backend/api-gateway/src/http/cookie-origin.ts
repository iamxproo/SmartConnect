import { buildProblem, sendProblem } from '@smartconnect/backend-kit';
import type { NextFunction, Request, Response } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie-authenticated endpoints (docs/api/conventions.md: the refresh cookie is protected by
 * SameSite=Strict AND an Origin allow-list check). Browsers attach cookies automatically and always send `Origin`
 * on state-changing requests, so a state-changing request that carries cookies must come from an allowed origin.
 * Bearer-token calls carry no cookies and are unaffected.
 */
export function requireAllowedOriginForCookies(allowedOrigins: readonly string[], errorTypeBaseUrl: string) {
  const allowed = new Set(allowedOrigins);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method) || req.headers.cookie === undefined) return next();
    const origin = req.get('origin');
    if (origin !== undefined && allowed.has(origin)) return next();
    sendProblem(
      res,
      buildProblem(req, errorTypeBaseUrl, 403, {
        code: 'origin_not_allowed',
        detail: 'Requests that carry cookies must come from an allowed origin.',
      }),
    );
  };
}
