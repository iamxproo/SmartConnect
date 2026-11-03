// Deny-by-default authentication for every NestJS service: AccessTokenGuard is registered as a global guard
// (APP_GUARD), so a new route is protected unless it is explicitly marked @Public().
import {
  createParamDecorator,
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiProblemException } from '../http/problem-details.js';
import { AccessTokenError, type AccessTokenVerifier, type Principal } from './access-token.js';

export const IS_PUBLIC = 'smartconnect:public';

/** Marks a controller or handler as reachable without an access token. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Injection token for the AccessTokenVerifier the guard uses. */
export const ACCESS_TOKEN_VERIFIER = Symbol('ACCESS_TOKEN_VERIFIER');

const principals = new WeakMap<Request, Principal>();

/** The verified principal of a request, if AccessTokenGuard authenticated it. */
export function principalOf(req: Request): Principal | undefined {
  return principals.get(req);
}

/** Handler parameter: the verified principal. Only valid on routes the guard protects. */
export const CurrentPrincipal = createParamDecorator((_data: unknown, context: ExecutionContext): Principal => {
  const principal = principals.get(context.switchToHttp().getRequest<Request>());
  // A programming error (decorator on a @Public route), not a client error: surfaces as a generic 500.
  if (!principal) throw new Error('@CurrentPrincipal() used on a route that AccessTokenGuard does not protect');
  return principal;
});

const BEARER = /^Bearer +([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;
const REALM = 'Bearer realm="smartconnect"';

function invalidToken(): ApiProblemException {
  return new ApiProblemException(401, 'invalid_token', 'The access token is invalid.', undefined, {
    'WWW-Authenticate': `${REALM}, error="invalid_token"`,
  });
}

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ACCESS_TOKEN_VERIFIER) private readonly verifier: AccessTokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;
    if (context.getType() !== 'http') return false;

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.get('authorization');
    if (header === undefined) {
      throw new ApiProblemException(401, 'unauthenticated', 'An access token is required.', undefined, {
        'WWW-Authenticate': REALM,
      });
    }
    const token = BEARER.exec(header)?.[1];
    if (!token) throw invalidToken();
    try {
      principals.set(req, await this.verifier.verify(token));
      return true;
    } catch (error) {
      if (error instanceof AccessTokenError && error.reason === 'expired') {
        throw new ApiProblemException(401, 'token_expired', 'The access token has expired.', undefined, {
          'WWW-Authenticate': `${REALM}, error="invalid_token", error_description="expired"`,
        });
      }
      throw invalidToken();
    }
  }
}
