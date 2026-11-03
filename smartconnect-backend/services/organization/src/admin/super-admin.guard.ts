import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { IdentityClient } from '../access/identity.client.js';
import { passwordChangeRequired, platformAdminRequired } from '../errors.js';

/**
 * Platform administration (ADR 0015). The caller's platform role is read from the identity service on every request
 * (forwarding the caller's token, like organization creation does); access tokens never carry roles. Organization
 * roles play no part: an organization owner or admin is not a platform administrator, and a Super Admin gains no
 * access to any organization's own routes (those still require membership, OrgMemberGuard).
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  constructor(@Inject(IdentityClient) private readonly identity: IdentityClient) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const account = await this.identity.me(context.switchToHttp().getRequest<Request>());
    if (!account.platformRoles?.includes('super_admin')) throw platformAdminRequired();
    if (account.passwordChangeRequired !== false) throw passwordChangeRequired();
    return true;
  }
}
