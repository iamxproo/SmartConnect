import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses, BEARER_AUTH, CurrentPrincipal, type Principal } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import { CurrentOrg, OrganizationScoped } from '../access/access.guard.js';
import type { OrgMembership } from '../access/organization-directory.js';
import { PageQueryDto } from '../messages/dto.js';
import { SavedMessageListDto } from './dto.js';
import { SavedMessagesService } from './saved-messages.service.js';

@ApiTags('Saved messages')
@ApiBearerAuth(BEARER_AUTH)
@OrganizationScoped()
@Controller('orgs/:orgId/saved-messages')
export class SavedMessagesController {
  constructor(@Inject(SavedMessagesService) private readonly saved: SavedMessagesService) {}

  @Get()
  @ApiOperation({ summary: 'Messages I saved that I can still see, most recently saved first' })
  @ApiOkResponse({ type: SavedMessageListDto })
  @ApiProblemResponses(401, 404, 422, 503)
  list(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Query() query: PageQueryDto,
    @Req() req: Request,
  ): Promise<SavedMessageListDto> {
    const actor = { organizationId: org.organizationId, userId: principal.userId.toLowerCase() };
    return this.saved.list(actor, query.limit ?? 50, query.cursor, req);
  }
}
