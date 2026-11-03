import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses, BEARER_AUTH, CurrentPrincipal, type Principal } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import { CurrentOrg, OrganizationScoped } from '../access/access.guard.js';
import type { OrgMembership } from '../access/organization-directory.js';
import { UuidParam } from '../common/uuid-param.js';
import { AttachmentsService } from './attachments.service.js';
import { AttachmentAccessDto } from './dto.js';

@ApiTags('Attachments')
@ApiBearerAuth(BEARER_AUTH)
@OrganizationScoped()
@Controller('orgs/:orgId/attachments')
export class AttachmentsController {
  constructor(@Inject(AttachmentsService) private readonly attachments: AttachmentsService) {}

  @Get(':fileId')
  @ApiOperation({
    summary: 'Whether I can see a message that attaches this file (used by the files service to authorize readers)',
  })
  @ApiOkResponse({ type: AttachmentAccessDto })
  @ApiProblemResponses(401, 404, 503)
  async access(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('fileId', UuidParam()) fileId: string,
    @Req() req: Request,
  ): Promise<AttachmentAccessDto> {
    await this.attachments.requireVisible(
      { organizationId: org.organizationId, userId: principal.userId.toLowerCase() },
      fileId,
      req,
    );
    return { fileId: fileId.toLowerCase() };
  }
}
