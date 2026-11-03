import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { principalOf } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import { passwordChangeRequired, platformAdminRequired } from '../auth/errors.js';
import { PRISMA, type IdentityPrisma } from '../database/prisma.token.js';

/**
 * Platform administration (ADR 0015). Runs after the global AccessTokenGuard and ActiveSessionGuard: passes only an
 * active account that holds the super_admin platform role and no longer holds the issued initial password. The role
 * is read from the database on every request (access tokens never carry roles), so revoking it takes effect at once.
 * Organization roles play no part here: an organization owner or admin is not a platform administrator.
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  constructor(@Inject(PRISMA) private readonly prisma: IdentityPrisma) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const principal = principalOf(context.switchToHttp().getRequest<Request>());
    if (!principal) throw platformAdminRequired();
    const user = await this.prisma.user.findUnique({
      where: { id: principal.userId },
      select: {
        status: true,
        deletedAt: true,
        platformRoles: { where: { role: 'super_admin' }, select: { role: true } },
        credentials: { where: { type: 'password' }, select: { changeRequired: true } },
      },
    });
    if (!user || user.status !== 'active' || user.deletedAt || user.platformRoles.length === 0) {
      throw platformAdminRequired();
    }
    if (user.credentials[0]?.changeRequired !== false) throw passwordChangeRequired();
    return true;
  }
}
