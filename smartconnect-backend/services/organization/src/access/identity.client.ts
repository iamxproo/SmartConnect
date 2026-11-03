import { Inject, Injectable } from '@nestjs/common';
import { ApiProblemException, ServiceClient } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import { ORGANIZATION_CONFIG, type OrganizationConfig } from '../config.js';

export interface CallerAccount {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  /** Platform-wide roles (ADR 0015). Absent from an older identity service, which then grants no platform access. */
  platformRoles?: string[];
  passwordChangeRequired?: boolean;
}

/** Reads the CALLER'S own account from the identity service (forwarding the caller's access token). */
@Injectable()
export class IdentityClient {
  private readonly client: ServiceClient;

  constructor(@Inject(ORGANIZATION_CONFIG) config: OrganizationConfig) {
    this.client = new ServiceClient('identity', config.identityServiceUrl);
  }

  async me(req: Request): Promise<CallerAccount> {
    const { status, body } = await this.client.get<CallerAccount>('/api/v1/auth/me', req);
    if (status === 200 && body) return body;
    // 401: the caller's session ended after the gateway verified the token.
    if (status === 401) throw new ApiProblemException(401, 'session_revoked', 'This session has ended; log in again.');
    throw new ApiProblemException(503, 'dependency_unavailable', 'A required service is temporarily unavailable.');
  }
}
