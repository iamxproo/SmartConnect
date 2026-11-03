import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOkResponse, ApiOperation, ApiTags, getSchemaPath } from '@nestjs/swagger';
import { ApiProblemResponses, BEARER_AUTH, CurrentPrincipal, type Principal } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import { CurrentOrg, OrganizationScoped } from '../access/access.guard.js';
import type { OrgMembership } from '../access/organization-directory.js';
import { invalid } from '../common/errors.js';
import { FileSearchDto, MessageSearchDto, SearchQueryDto } from './dto.js';
import { SearchService } from './search.service.js';

@ApiTags('Search')
@ApiBearerAuth(BEARER_AUTH)
@ApiExtraModels(MessageSearchDto, FileSearchDto)
@OrganizationScoped()
@Controller('orgs/:orgId/message-search')
export class SearchController {
  constructor(@Inject(SearchService) private readonly search: SearchService) {}

  @Get()
  @ApiOperation({
    summary: 'Search messages (or attachment names with type=files) in the channels and conversations I can see',
  })
  @ApiOkResponse({
    schema: { oneOf: [{ $ref: getSchemaPath(MessageSearchDto) }, { $ref: getSchemaPath(FileSearchDto) }] },
  })
  @ApiProblemResponses(401, 404, 422, 503)
  run(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Query() query: SearchQueryDto,
    @Req() req: Request,
  ): Promise<MessageSearchDto | FileSearchDto> {
    if (query.channelId && query.conversationId)
      throw invalid('conversationId', 'conflicting_filters', 'Use channelId or conversationId, not both.');
    const actor = { organizationId: org.organizationId, userId: principal.userId.toLowerCase() };
    return this.search.run(actor, query, req);
  }
}
