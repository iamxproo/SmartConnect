// Public surface of the organization and workspace services (docs/api/endpoints.md). Every route is protected
// (global AccessTokenGuard) except the invitation preview; the services authorize everything else themselves
// (organization membership, roles, private workspaces/teams/channels). Request/response schemas: each service's
// own OpenAPI document. Catch-all forwards are excluded from this gateway's document for that reason.
import { All, Controller, Get, Inject, Post, Put, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses, BEARER_AUTH, Public } from '@smartconnect/backend-kit';
import type { Request, Response } from 'express';
import { GATEWAY_CONFIG, type GatewayConfig } from '../config/config.js';
import { UpstreamProxy } from '../proxy/upstream-proxy.js';
import { RateLimit, type RateLimitRule } from '../rate-limit/rate-limit.js';

const MINUTE = 60;
const HOUR = 60 * MINUTE;

export const TENANT_RATE_LIMITS = {
  // Self-service organization creation (ADR 0017): per person and per client address, on top of the service's cap on
  // owned organizations.
  organizationCreate: [
    { name: 'organization-create-user', key: 'user', limit: 10, windowSeconds: HOUR },
    { name: 'organization-create-ip', key: 'ip', limit: 20, windowSeconds: HOUR },
  ],
  invitationPreview: [{ name: 'invitation-preview-ip', key: 'ip', limit: 30, windowSeconds: 10 * MINUTE }],
  invitationAccept: [{ name: 'invitation-accept-user', key: 'user', limit: 10, windowSeconds: 15 * MINUTE }],
  invitationCreate: [{ name: 'invitation-create-user', key: 'user', limit: 50, windowSeconds: HOUR }],
  api: [{ name: 'tenant-api-user', key: 'user', limit: 300, windowSeconds: MINUTE }],
  messagePost: [{ name: 'message-post-user', key: 'user', limit: 120, windowSeconds: MINUTE }],
  fileCreate: [{ name: 'file-create-user', key: 'user', limit: 100, windowSeconds: HOUR }],
  messageSearch: [{ name: 'message-search-user', key: 'user', limit: 60, windowSeconds: MINUTE }],
  activityRead: [{ name: 'activity-read-user', key: 'user', limit: 120, windowSeconds: MINUTE }],
  fileUpload: [{ name: 'file-upload-user', key: 'user', limit: 100, windowSeconds: HOUR }],
} satisfies Record<string, RateLimitRule[]>;

const MESSAGES = 'orgs/:orgId/workspaces/:wsId/channels/:chId/messages';
const CONVERSATIONS = 'orgs/:orgId/conversations';

/**
 * Channel messages and direct/group conversations. Must be registered BEFORE WorkspaceRoutesController (message
 * paths are nested under workspace paths) and OrganizationRoutesController (conversations sit under /orgs/:orgId).
 */
@ApiTags('Messages')
@Controller()
export class MessagingRoutesController {
  constructor(@Inject(UpstreamProxy) private readonly proxy: UpstreamProxy) {}

  @Post([MESSAGES, `${CONVERSATIONS}/:conversationId/messages`])
  @RateLimit(...TENANT_RATE_LIMITS.messagePost)
  @ApiExcludeEndpoint()
  post(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.proxy.forward('messaging', req, res);
  }

  /** Expensive reads (full-text search; a visible-channels walk per call) get their own, tighter per-user budgets. */
  @Get('orgs/:orgId/message-search')
  @RateLimit(...TENANT_RATE_LIMITS.messageSearch)
  @ApiExcludeEndpoint()
  search(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.proxy.forward('messaging', req, res);
  }

  @Get(['orgs/:orgId/activity', 'orgs/:orgId/activity/unread-count'])
  @RateLimit(...TENANT_RATE_LIMITS.activityRead)
  @ApiExcludeEndpoint()
  activity(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.proxy.forward('messaging', req, res);
  }

  @All([
    MESSAGES,
    `${MESSAGES}/*path`,
    CONVERSATIONS,
    `${CONVERSATIONS}/*path`,
    'orgs/:orgId/saved-messages',
    'orgs/:orgId/attachments/*path',
    'orgs/:orgId/activity',
    'orgs/:orgId/activity/*path',
    'orgs/:orgId/message-search',
    'orgs/:orgId/notification-preferences',
  ])
  @RateLimit(...TENANT_RATE_LIMITS.api)
  @ApiExcludeEndpoint()
  forward(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.proxy.forward('messaging', req, res);
  }
}

/**
 * Files (ADR 0013). The two content routes stream raw bytes both ways (UpstreamProxy.stream, bounded by
 * filesMaxBytes); every other files route is JSON like the rest. Routes are declared in this order on purpose: the
 * specific content paths and the create route must precede the catch-all. Registered BEFORE OrganizationRoutesController.
 */
@ApiTags('Files')
@Controller()
export class FilesRoutesController {
  constructor(
    @Inject(UpstreamProxy) private readonly proxy: UpstreamProxy,
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
  ) {}

  @Put('orgs/:orgId/files/:fileId/content')
  @RateLimit(...TENANT_RATE_LIMITS.fileUpload)
  @ApiExcludeEndpoint()
  upload(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.proxy.stream('files', req, res, { maxBytes: this.config.filesMaxBytes });
  }

  @Get('orgs/:orgId/files/:fileId/content')
  @RateLimit(...TENANT_RATE_LIMITS.api)
  @ApiExcludeEndpoint()
  download(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.proxy.stream('files', req, res, { maxBytes: this.config.filesMaxBytes });
  }

  @Post('orgs/:orgId/files')
  @RateLimit(...TENANT_RATE_LIMITS.fileCreate)
  @ApiExcludeEndpoint()
  create(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.proxy.forward('files', req, res);
  }

  @All(['orgs/:orgId/files', 'orgs/:orgId/files/*path'])
  @RateLimit(...TENANT_RATE_LIMITS.api)
  @ApiExcludeEndpoint()
  forward(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.proxy.forward('files', req, res);
  }
}

/** Must be registered BEFORE OrganizationRoutesController: Express takes the first matching route. */
@ApiTags('Workspaces')
@Controller()
export class WorkspaceRoutesController {
  constructor(@Inject(UpstreamProxy) private readonly proxy: UpstreamProxy) {}

  @All(['orgs/:orgId/workspaces', 'orgs/:orgId/workspaces/*path', 'orgs/:orgId/channels', 'orgs/:orgId/channels/*path'])
  @RateLimit(...TENANT_RATE_LIMITS.api)
  @ApiExcludeEndpoint()
  forward(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.proxy.forward('workspace', req, res);
  }
}

@ApiTags('Organizations')
@Controller()
export class OrganizationRoutesController {
  constructor(@Inject(UpstreamProxy) private readonly proxy: UpstreamProxy) {}

  @Public()
  @Post('invitations/preview')
  @RateLimit(...TENANT_RATE_LIMITS.invitationPreview)
  @ApiOperation({ summary: 'What an invitation is for (public; token in the body, never in the URL)' })
  @ApiResponse({ status: 200, description: 'Organization, role and a hint of the invited address' })
  @ApiProblemResponses(404, 422, 429)
  preview(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.proxy.forward('organization', req, res);
  }

  @Post('invitations/accept')
  @RateLimit(...TENANT_RATE_LIMITS.invitationAccept)
  @ApiBearerAuth(BEARER_AUTH)
  @ApiOperation({ summary: 'Accept an invitation with the verified, invited account' })
  @ApiResponse({ status: 200, description: 'Membership created' })
  @ApiProblemResponses(401, 403, 404, 409, 422, 429)
  accept(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.proxy.forward('organization', req, res);
  }

  @Post('orgs')
  @RateLimit(...TENANT_RATE_LIMITS.organizationCreate)
  @ApiBearerAuth(BEARER_AUTH)
  @ApiOperation({ summary: 'Create an organization; the caller becomes its owner' })
  @ApiResponse({ status: 201, description: 'Organization created' })
  @ApiResponse({ status: 200, description: 'The same request again: the organization it created' })
  @ApiProblemResponses(401, 403, 409, 422, 429)
  createOrganization(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.proxy.forward('organization', req, res);
  }

  @Post('orgs/:orgId/invitations')
  @RateLimit(...TENANT_RATE_LIMITS.invitationCreate)
  @ApiBearerAuth(BEARER_AUTH)
  @ApiOperation({ summary: 'Invite someone by email (members.invite)' })
  @ApiResponse({ status: 201, description: 'Invitation created and emailed' })
  @ApiProblemResponses(401, 403, 404, 409, 422, 429)
  invite(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.proxy.forward('organization', req, res);
  }

  @All(['orgs', 'orgs/*path'])
  @RateLimit(...TENANT_RATE_LIMITS.api)
  @ApiExcludeEndpoint()
  forward(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.proxy.forward('organization', req, res);
  }
}
