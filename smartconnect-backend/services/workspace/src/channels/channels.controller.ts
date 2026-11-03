import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiProblemResponses, BEARER_AUTH, CurrentPrincipal, type Principal } from '@smartconnect/backend-kit';
import type { Response } from 'express';
import { PageQueryDto, pageOf } from '../common/pagination.js';
import { SearchPageQueryDto } from '../common/search.js';
import { UuidParam } from '../common/uuid-param.js';
import { CurrentOrg } from '../org/org-membership.guard.js';
import type { OrgMembership } from '../org/organization-directory.js';
import { ChannelsService } from './channels.service.js';
import {
  ChannelDto,
  ChannelListDto,
  ChannelMemberDto,
  ChannelMemberListDto,
  ChannelSearchListDto,
  CreateChannelDto,
  PutChannelMemberDto,
} from './dto.js';

const actorOf = (org: OrgMembership, principal: Principal) => ({
  organizationId: org.organizationId,
  userId: principal.userId,
});

/** Every route is protected: the global AccessTokenGuard authenticates and OrgMembershipGuard checks the path's org. */
@ApiTags('Channels')
@ApiBearerAuth(BEARER_AUTH)
@Controller('orgs/:orgId/channels')
export class OrgChannelsController {
  constructor(@Inject(ChannelsService) private readonly channels: ChannelsService) {}

  @Get()
  @ApiOperation({ summary: 'Channels visible to the caller across all their workspaces; q searches the name' })
  @ApiOkResponse({ type: ChannelSearchListDto })
  @ApiProblemResponses(401, 404, 422)
  list(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Query() query: SearchPageQueryDto,
  ): Promise<ChannelSearchListDto> {
    return this.channels.listVisible(actorOf(org, principal), query.q, pageOf(query));
  }
}

/** Every route is protected: the global AccessTokenGuard authenticates and OrgMembershipGuard checks the path's org. */
@ApiTags('Channels')
@ApiBearerAuth(BEARER_AUTH)
@Controller('orgs/:orgId/workspaces/:workspaceId/channels')
export class ChannelsController {
  constructor(@Inject(ChannelsService) private readonly channels: ChannelsService) {}

  @Get()
  @ApiOperation({ summary: 'Public channels, plus the private ones the caller belongs to (workspace members)' })
  @ApiOkResponse({ type: ChannelListDto })
  @ApiProblemResponses(401, 404, 422)
  list(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', UuidParam()) workspaceId: string,
    @Query() query: PageQueryDto,
  ): Promise<ChannelListDto> {
    return this.channels.list(actorOf(org, principal), workspaceId, pageOf(query));
  }

  @Post()
  @ApiOperation({ summary: 'Create a channel (workspace members); the caller becomes channel admin' })
  @ApiCreatedResponse({ type: ChannelDto })
  @ApiProblemResponses(401, 403, 404, 409, 422)
  async create(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', UuidParam()) workspaceId: string,
    @Body() dto: CreateChannelDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ChannelDto> {
    const channel = await this.channels.create(actorOf(org, principal), workspaceId, dto);
    res.setHeader('Location', `/api/v1/orgs/${org.organizationId}/workspaces/${workspaceId}/channels/${channel.id}`);
    return channel;
  }

  @Get(':channelId')
  @ApiOperation({ summary: 'A public channel (workspace member) or a private one (channel member)' })
  @ApiOkResponse({ type: ChannelDto })
  @ApiProblemResponses(401, 404)
  get(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', UuidParam()) workspaceId: string,
    @Param('channelId', UuidParam()) channelId: string,
  ): Promise<ChannelDto> {
    return this.channels.get(actorOf(org, principal), workspaceId, channelId);
  }

  @Post(':channelId/join')
  @HttpCode(200)
  @ApiOperation({ summary: 'Join a public channel' })
  @ApiOkResponse({ type: ChannelDto })
  @ApiProblemResponses(401, 404)
  join(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', UuidParam()) workspaceId: string,
    @Param('channelId', UuidParam()) channelId: string,
  ): Promise<ChannelDto> {
    return this.channels.join(actorOf(org, principal), workspaceId, channelId);
  }

  @Post(':channelId/leave')
  @HttpCode(204)
  @ApiOperation({ summary: 'Leave a channel. 409 last_admin for the last admin of a private channel' })
  @ApiNoContentResponse()
  @ApiProblemResponses(401, 404, 409)
  leave(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', UuidParam()) workspaceId: string,
    @Param('channelId', UuidParam()) channelId: string,
  ): Promise<void> {
    return this.channels.leave(actorOf(org, principal), workspaceId, channelId);
  }

  @Get(':channelId/members')
  @ApiOperation({ summary: 'Members of a channel the caller can see' })
  @ApiOkResponse({ type: ChannelMemberListDto })
  @ApiProblemResponses(401, 404, 422)
  listMembers(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', UuidParam()) workspaceId: string,
    @Param('channelId', UuidParam()) channelId: string,
    @Query() query: PageQueryDto,
  ): Promise<ChannelMemberListDto> {
    return this.channels.listMembers(actorOf(org, principal), workspaceId, channelId, pageOf(query));
  }

  @Put(':channelId/members/:userId')
  @ApiOperation({ summary: 'Add a workspace member to a channel, or change their role' })
  @ApiOkResponse({ type: ChannelMemberDto })
  @ApiProblemResponses(401, 403, 404, 409, 422)
  putMember(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', UuidParam()) workspaceId: string,
    @Param('channelId', UuidParam()) channelId: string,
    @Param('userId', UuidParam()) userId: string,
    @Body() dto: PutChannelMemberDto,
  ): Promise<ChannelMemberDto> {
    return this.channels.putMember(actorOf(org, principal), workspaceId, channelId, userId, dto.role);
  }

  @Delete(':channelId/members/:userId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a member (channel admin, or yourself)' })
  @ApiNoContentResponse()
  @ApiProblemResponses(401, 403, 404, 409)
  deleteMember(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', UuidParam()) workspaceId: string,
    @Param('channelId', UuidParam()) channelId: string,
    @Param('userId', UuidParam()) userId: string,
  ): Promise<void> {
    return this.channels.deleteMember(actorOf(org, principal), workspaceId, channelId, userId);
  }
}
