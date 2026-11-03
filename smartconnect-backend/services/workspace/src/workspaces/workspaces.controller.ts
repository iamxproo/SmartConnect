import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiProblemException,
  ApiProblemResponses,
  BEARER_AUTH,
  CurrentPrincipal,
  type Principal,
} from '@smartconnect/backend-kit';
import type { Request, Response } from 'express';
import { PageQueryDto, pageOf } from '../common/pagination.js';
import { SearchPageQueryDto } from '../common/search.js';
import { UuidParam } from '../common/uuid-param.js';
import { CurrentOrg } from '../org/org-membership.guard.js';
import { hasPermission, type OrgMembership } from '../org/organization-directory.js';
import {
  CreateWorkspaceDto,
  PutWorkspaceMemberDto,
  UpdateWorkspaceDto,
  WorkspaceDto,
  WorkspaceListDto,
  WorkspaceMemberDto,
  WorkspaceMemberListDto,
} from './dto.js';
import { WorkspacesService } from './workspaces.service.js';

const actorOf = (org: OrgMembership, principal: Principal) => ({
  organizationId: org.organizationId,
  userId: principal.userId,
});

/** Every route is protected: the global AccessTokenGuard authenticates and OrgMembershipGuard checks the path's org. */
@ApiTags('Workspaces')
@ApiBearerAuth(BEARER_AUTH)
@Controller('orgs/:orgId/workspaces')
export class WorkspacesController {
  constructor(@Inject(WorkspacesService) private readonly workspaces: WorkspacesService) {}

  @Get()
  @ApiOperation({ summary: 'Open workspaces, plus the private ones the caller belongs to; q searches the name' })
  @ApiOkResponse({ type: WorkspaceListDto })
  @ApiProblemResponses(401, 404, 422)
  list(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Query() query: SearchPageQueryDto,
  ): Promise<WorkspaceListDto> {
    return this.workspaces.list(actorOf(org, principal), query.q, pageOf(query));
  }

  @Post()
  @ApiOperation({ summary: 'Create a workspace (needs workspaces.create); the caller becomes admin' })
  @ApiCreatedResponse({ type: WorkspaceDto })
  @ApiProblemResponses(401, 403, 404, 409, 422)
  async create(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateWorkspaceDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WorkspaceDto> {
    if (!hasPermission(org.permissions, 'workspaces.create'))
      throw new ApiProblemException(403, 'forbidden', 'You are not allowed to create workspaces.');
    const workspace = await this.workspaces.create(actorOf(org, principal), dto);
    res.setHeader('Location', `/api/v1/orgs/${org.organizationId}/workspaces/${workspace.id}`);
    return workspace;
  }

  @Get(':workspaceId')
  @ApiOperation({ summary: 'An open workspace, or one the caller belongs to' })
  @ApiOkResponse({ type: WorkspaceDto })
  @ApiProblemResponses(401, 404)
  get(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', UuidParam()) workspaceId: string,
  ): Promise<WorkspaceDto> {
    return this.workspaces.get(actorOf(org, principal), workspaceId);
  }

  @Patch(':workspaceId')
  @ApiOperation({ summary: 'Update a workspace (workspace admin)' })
  @ApiOkResponse({ type: WorkspaceDto })
  @ApiProblemResponses(401, 403, 404, 422)
  update(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', UuidParam()) workspaceId: string,
    @Body() dto: UpdateWorkspaceDto,
  ): Promise<WorkspaceDto> {
    return this.workspaces.update(actorOf(org, principal), workspaceId, dto);
  }

  @Post(':workspaceId/join')
  @HttpCode(200)
  @ApiOperation({ summary: 'Join an open workspace (and its default channels)' })
  @ApiOkResponse({ type: WorkspaceDto })
  @ApiProblemResponses(401, 404)
  join(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', UuidParam()) workspaceId: string,
  ): Promise<WorkspaceDto> {
    return this.workspaces.join(actorOf(org, principal), workspaceId);
  }

  @Post(':workspaceId/leave')
  @HttpCode(204)
  @ApiOperation({ summary: 'Leave a workspace. 409 last_admin for the last admin' })
  @ApiNoContentResponse()
  @ApiProblemResponses(401, 404, 409)
  leave(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', UuidParam()) workspaceId: string,
  ): Promise<void> {
    return this.workspaces.leave(actorOf(org, principal), workspaceId);
  }

  @Get(':workspaceId/members')
  @ApiOperation({ summary: 'Workspace members (members only)' })
  @ApiOkResponse({ type: WorkspaceMemberListDto })
  @ApiProblemResponses(401, 403, 404, 422)
  listMembers(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', UuidParam()) workspaceId: string,
    @Query() query: PageQueryDto,
  ): Promise<WorkspaceMemberListDto> {
    return this.workspaces.listMembers(actorOf(org, principal), workspaceId, pageOf(query));
  }

  @Put(':workspaceId/members/:userId')
  @ApiOperation({ summary: 'Add an organization member, or change their role (workspace admin)' })
  @ApiOkResponse({ type: WorkspaceMemberDto })
  @ApiProblemResponses(401, 403, 404, 409, 422)
  putMember(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', UuidParam()) workspaceId: string,
    @Param('userId', UuidParam()) userId: string,
    @Body() dto: PutWorkspaceMemberDto,
    @Req() req: Request,
  ): Promise<WorkspaceMemberDto> {
    return this.workspaces.putMember(actorOf(org, principal), workspaceId, userId, dto.role, req);
  }

  @Delete(':workspaceId/members/:userId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a member (workspace admin). 409 last_admin' })
  @ApiNoContentResponse()
  @ApiProblemResponses(401, 403, 404, 409)
  deleteMember(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', UuidParam()) workspaceId: string,
    @Param('userId', UuidParam()) userId: string,
  ): Promise<void> {
    return this.workspaces.deleteMember(actorOf(org, principal), workspaceId, userId);
  }
}
