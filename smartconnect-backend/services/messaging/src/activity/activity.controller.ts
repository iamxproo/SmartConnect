import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses, BEARER_AUTH, CurrentPrincipal, type Principal } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import { CurrentOrg, OrganizationScoped } from '../access/access.guard.js';
import type { OrgMembership } from '../access/organization-directory.js';
import { ActivityService } from './activity.service.js';
import { ActivityListDto, ActivityQueryDto, ReadItemsDto, UnreadCountDto } from './dto.js';

const actorOf = (org: OrgMembership, principal: Principal) => ({
  organizationId: org.organizationId,
  userId: principal.userId.toLowerCase(),
});

/** Every route is protected: AccessTokenGuard authenticates, AccessGuard asks the organization service. */
@ApiTags('Activity')
@ApiBearerAuth(BEARER_AUTH)
@OrganizationScoped()
@Controller('orgs/:orgId/activity')
export class ActivityController {
  constructor(@Inject(ActivityService) private readonly activity: ActivityService) {}

  @Get()
  @ApiOperation({ summary: 'Mentions of me and replies in threads I take part in, newest first' })
  @ApiOkResponse({ type: ActivityListDto })
  @ApiProblemResponses(401, 404, 422, 503)
  list(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Query() query: ActivityQueryDto,
    @Req() req: Request,
  ): Promise<ActivityListDto> {
    return this.activity.list(actorOf(org, principal), query.filter ?? 'all', query.limit ?? 30, query.cursor, req);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Unread activity items, capped at 100' })
  @ApiOkResponse({ type: UnreadCountDto })
  @ApiProblemResponses(401, 404, 503)
  async unreadCount(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<UnreadCountDto> {
    return { count: await this.activity.unreadCount(actorOf(org, principal), req) };
  }

  @Post('read')
  @HttpCode(204)
  @ApiOperation({ summary: 'Mark activity items read; ids that are not my visible activity are ignored' })
  @ApiNoContentResponse()
  @ApiProblemResponses(401, 404, 422, 503)
  async read(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Body() dto: ReadItemsDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.activity.markRead(actorOf(org, principal), dto.itemIds, req);
  }

  @Post('read-all')
  @HttpCode(204)
  @ApiOperation({ summary: 'Mark all activity up to now read' })
  @ApiNoContentResponse()
  @ApiProblemResponses(401, 404)
  async readAll(@CurrentOrg() org: OrgMembership, @CurrentPrincipal() principal: Principal): Promise<void> {
    await this.activity.markAllRead(actorOf(org, principal));
  }
}
