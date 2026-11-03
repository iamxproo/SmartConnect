// Platform administration (ADR 0015). Read-only and explicit: only the routes below are forwarded, nothing else
// under /admin. The gateway authenticates and rate-limits; each service decides, on every request, whether the caller
// is a Super Admin (the role is looked up in the identity service; access tokens carry no roles) and answers 403
// otherwise. Request/response schemas: each service's own OpenAPI document.
import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses, BEARER_AUTH } from '@smartconnect/backend-kit';
import type { Request, Response } from 'express';
import { UpstreamProxy } from '../proxy/upstream-proxy.js';
import { RateLimit, type RateLimitRule } from '../rate-limit/rate-limit.js';

export const ADMIN_RATE_LIMITS = {
  api: [{ name: 'admin-api-user', key: 'user', limit: 60, windowSeconds: 60 }],
} satisfies Record<string, RateLimitRule[]>;

@ApiTags('Platform administration')
@ApiBearerAuth(BEARER_AUTH)
@Controller('admin')
export class AdminRoutesController {
  constructor(@Inject(UpstreamProxy) private readonly proxy: UpstreamProxy) {}

  @Get('accounts/summary')
  @RateLimit(...ADMIN_RATE_LIMITS.api)
  @ApiOperation({ summary: 'Platform-wide account totals (Super Admin only)' })
  @ApiResponse({ status: 200, description: 'Account totals' })
  @ApiProblemResponses(401, 403, 429)
  accountSummary(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.proxy.forward('identity', req, res);
  }

  @Get('organizations')
  @RateLimit(...ADMIN_RATE_LIMITS.api)
  @ApiOperation({ summary: 'Every organization on the platform, newest first (Super Admin only)' })
  @ApiResponse({ status: 200, description: 'A page of organizations and the total' })
  @ApiProblemResponses(401, 403, 422, 429)
  organizations(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.proxy.forward('organization', req, res);
  }
}
