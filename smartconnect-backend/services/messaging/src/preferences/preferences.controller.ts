import { Body, Controller, Get, HttpCode, Inject, Param, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses, BEARER_AUTH, CurrentPrincipal, type Principal } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import { CurrentChannel, CurrentOrg, OrganizationScoped } from '../access/access.guard.js';
import type { OrgMembership } from '../access/organization-directory.js';
import type { ChannelAccess } from '../channels/channel-directory.js';
import { UuidParam } from '../common/uuid-param.js';
import { NotificationPreferenceListDto, SetLevelDto } from './dto.js';
import { PreferencesService } from './preferences.service.js';

const actorOf = (organizationId: string, principal: Principal) => ({
  organizationId,
  userId: principal.userId.toLowerCase(),
});

/** Every route is protected: AccessTokenGuard authenticates; AccessGuard checks the channel or the organization. */
@ApiTags('Notification preferences')
@ApiBearerAuth(BEARER_AUTH)
@Controller('orgs/:orgId')
export class PreferencesController {
  constructor(@Inject(PreferencesService) private readonly preferences: PreferencesService) {}

  @Put('workspaces/:workspaceId/channels/:channelId/messages/preferences')
  @HttpCode(204)
  @ApiOperation({ summary: 'Set my notification level for a visible channel' })
  @ApiNoContentResponse()
  @ApiProblemResponses(401, 404, 422, 503)
  async setChannel(
    @CurrentChannel() channel: ChannelAccess,
    @CurrentPrincipal() principal: Principal,
    @Body() dto: SetLevelDto,
  ): Promise<void> {
    await this.preferences.setForChannel(actorOf(channel.organizationId, principal), channel, dto.level);
  }

  @Put('conversations/:conversationId/preferences')
  @OrganizationScoped()
  @HttpCode(204)
  @ApiOperation({ summary: 'Set my notification level for a conversation I take part in' })
  @ApiNoContentResponse()
  @ApiProblemResponses(401, 404, 422, 503)
  async setConversation(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId', UuidParam()) conversationId: string,
    @Body() dto: SetLevelDto,
  ): Promise<void> {
    await this.preferences.setForConversation(actorOf(org.organizationId, principal), conversationId, dto.level);
  }

  @Get('notification-preferences')
  @OrganizationScoped()
  @ApiOperation({ summary: 'My notification levels that differ from `all`, for places I can still see' })
  @ApiOkResponse({ type: NotificationPreferenceListDto })
  @ApiProblemResponses(401, 404, 503)
  list(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ): Promise<NotificationPreferenceListDto> {
    return this.preferences.list(actorOf(org.organizationId, principal), req);
  }
}
