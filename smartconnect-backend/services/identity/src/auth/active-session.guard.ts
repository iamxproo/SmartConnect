import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC, principalOf } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import { sessionEnded } from './errors.js';
import { SessionService } from './session.service.js';

/**
 * Second global guard, after AccessTokenGuard: on the identity service's own protected routes, a valid access token
 * is not enough; its session must still be active. Logout, revocation and password changes therefore take effect
 * here immediately. (Elsewhere access tokens stay valid until they expire, at most ACCESS_TOKEN_TTL_SECONDS.)
 */
@Injectable()
export class ActiveSessionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;
    const principal = principalOf(context.switchToHttp().getRequest<Request>());
    if (!principal || !(await this.sessions.isActive(principal))) throw sessionEnded();
    return true;
  }
}
