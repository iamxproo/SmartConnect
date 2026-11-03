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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses, BEARER_AUTH } from '@smartconnect/backend-kit';
import { CurrentMembership, OrgMemberGuard, RequirePermission, type Membership } from '../access/org-member.guard.js';
import { ParseId } from '../organizations/organizations.controller.js';
import {
  CreateDepartmentDto,
  CreateTeamDto,
  ListTeamsQueryDto,
  PutTeamMemberDto,
  UpdateDepartmentDto,
  UpdateTeamDto,
} from './dto.js';
import { StructureService } from './structure.service.js';

@ApiTags('Departments')
@ApiBearerAuth(BEARER_AUTH)
@Controller('orgs/:orgId/departments')
@UseGuards(OrgMemberGuard)
export class DepartmentsController {
  constructor(@Inject(StructureService) private readonly structure: StructureService) {}

  @Get()
  @ApiOperation({ summary: "The organization's departments" })
  @ApiProblemResponses(404)
  list(@CurrentMembership() membership: Membership) {
    return this.structure.listDepartments(membership);
  }

  @Post()
  @RequirePermission('departments.manage')
  @ApiOperation({ summary: 'Create a department' })
  @ApiProblemResponses(403, 404, 409, 422)
  create(@CurrentMembership() membership: Membership, @Body() dto: CreateDepartmentDto) {
    return this.structure.createDepartment(membership, dto);
  }

  @Patch(':departmentId')
  @RequirePermission('departments.manage')
  @ApiOperation({ summary: 'Rename, describe or move a department' })
  @ApiProblemResponses(403, 404, 409, 422)
  update(
    @CurrentMembership() membership: Membership,
    @Param('departmentId', ParseId()) departmentId: string,
    @Body() dto: UpdateDepartmentDto,
  ) {
    return this.structure.updateDepartment(membership, departmentId, dto);
  }

  @Delete(':departmentId')
  @HttpCode(204)
  @RequirePermission('departments.manage')
  @ApiOperation({ summary: 'Delete an empty department' })
  @ApiProblemResponses(403, 404, 409)
  async remove(@CurrentMembership() membership: Membership, @Param('departmentId', ParseId()) departmentId: string) {
    await this.structure.deleteDepartment(membership, departmentId);
  }
}

@ApiTags('Teams')
@ApiBearerAuth(BEARER_AUTH)
@Controller('orgs/:orgId/teams')
@UseGuards(OrgMemberGuard)
export class TeamsController {
  constructor(@Inject(StructureService) private readonly structure: StructureService) {}

  @Get()
  @ApiOperation({ summary: 'Teams the caller can see (public, own private teams; all for team managers)' })
  @ApiProblemResponses(404, 422)
  list(@CurrentMembership() membership: Membership, @Query() query: ListTeamsQueryDto) {
    return this.structure.listTeams(membership, query);
  }

  @Post()
  @RequirePermission('teams.manage')
  @ApiOperation({ summary: 'Create a team' })
  @ApiProblemResponses(403, 404, 409, 422)
  create(@CurrentMembership() membership: Membership, @Body() dto: CreateTeamDto) {
    return this.structure.createTeam(membership, dto);
  }

  @Get(':teamId')
  @ApiOperation({ summary: 'A team (404 for private teams the caller does not belong to)' })
  @ApiProblemResponses(404)
  get(@CurrentMembership() membership: Membership, @Param('teamId', ParseId()) teamId: string) {
    return this.structure.getTeam(membership, teamId);
  }

  @Patch(':teamId')
  @RequirePermission('teams.manage')
  @ApiOperation({ summary: 'Update a team' })
  @ApiProblemResponses(403, 404, 409, 422)
  update(
    @CurrentMembership() membership: Membership,
    @Param('teamId', ParseId()) teamId: string,
    @Body() dto: UpdateTeamDto,
  ) {
    return this.structure.updateTeam(membership, teamId, dto);
  }

  @Delete(':teamId')
  @HttpCode(204)
  @RequirePermission('teams.manage')
  @ApiOperation({ summary: 'Delete a team' })
  @ApiProblemResponses(403, 404)
  async remove(@CurrentMembership() membership: Membership, @Param('teamId', ParseId()) teamId: string) {
    await this.structure.deleteTeam(membership, teamId);
  }

  @Get(':teamId/members')
  @ApiOperation({ summary: "A visible team's members" })
  @ApiProblemResponses(404)
  members(@CurrentMembership() membership: Membership, @Param('teamId', ParseId()) teamId: string) {
    return this.structure.listTeamMembers(membership, teamId);
  }

  @Put(':teamId/members/:userId')
  @ApiOperation({ summary: 'Add a member or change their team role (team managers; leads for plain members)' })
  @ApiProblemResponses(403, 404, 422)
  putMember(
    @CurrentMembership() membership: Membership,
    @Param('teamId', ParseId()) teamId: string,
    @Param('userId', ParseId()) userId: string,
    @Body() dto: PutTeamMemberDto,
  ) {
    return this.structure.putTeamMember(membership, teamId, userId, dto);
  }

  @Delete(':teamId/members/:userId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a team member (team managers, leads for plain members) or leave the team' })
  @ApiProblemResponses(403, 404)
  async removeMember(
    @CurrentMembership() membership: Membership,
    @Param('teamId', ParseId()) teamId: string,
    @Param('userId', ParseId()) userId: string,
  ) {
    await this.structure.removeTeamMember(membership, teamId, userId);
  }
}
