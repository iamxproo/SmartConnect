import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses, BEARER_AUTH, CurrentPrincipal, type Principal } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import {
  CurrentMembership,
  notFound,
  OrgMemberGuard,
  RequirePermission,
  type Membership,
} from '../access/org-member.guard.js';
import { CreateOrganizationDto, ListMembersQueryDto, UpdateMemberDto, UpdateOrganizationDto } from './dto.js';
import { OrganizationsService, toMembership } from './organizations.service.js';

/** Malformed ids are just ids the caller cannot see: 404, not a validation error. */
export const ParseId = () => new ParseUUIDPipe({ exceptionFactory: () => notFound() });

@ApiTags('Organizations')
@ApiBearerAuth(BEARER_AUTH)
@Controller('orgs')
export class OrganizationsController {
  constructor(@Inject(OrganizationsService) private readonly organizations: OrganizationsService) {}

  @Get()
  @ApiOperation({ summary: "The caller's organizations" })
  list(@CurrentPrincipal() principal: Principal) {
    return this.organizations.listMine(principal.userId);
  }

  @Post()
  @ApiOperation({ summary: 'Create an organization (authorized administrators with a verified email only)' })
  @ApiProblemResponses(403, 409, 422)
  create(@Req() req: Request, @CurrentPrincipal() principal: Principal, @Body() dto: CreateOrganizationDto) {
    return this.organizations.create(req, principal, dto);
  }

  @Get(':orgId')
  @UseGuards(OrgMemberGuard)
  @ApiOperation({ summary: 'Organization profile and settings' })
  @ApiProblemResponses(404)
  get(@CurrentMembership() membership: Membership) {
    return this.organizations.get(membership);
  }

  @Patch(':orgId')
  @UseGuards(OrgMemberGuard)
  @RequirePermission('organization.update')
  @ApiOperation({ summary: 'Update the organization profile and settings' })
  @ApiProblemResponses(403, 404, 422)
  update(@CurrentMembership() membership: Membership, @Body() dto: UpdateOrganizationDto) {
    return this.organizations.update(membership, dto);
  }

  @Get(':orgId/me')
  @UseGuards(OrgMemberGuard)
  @ApiOperation({ summary: "The caller's membership: role and permissions" })
  @ApiProblemResponses(404)
  me(@CurrentMembership() membership: Membership) {
    return toMembership(membership);
  }

  @Get(':orgId/roles')
  @UseGuards(OrgMemberGuard)
  @ApiOperation({ summary: "The organization's roles" })
  @ApiProblemResponses(404)
  roles(@CurrentMembership() membership: Membership) {
    return this.organizations.roles(membership);
  }

  @Get(':orgId/members')
  @UseGuards(OrgMemberGuard)
  @ApiOperation({ summary: 'Active members (cursor-paginated); q searches display name and email' })
  @ApiProblemResponses(404, 422)
  members(@CurrentMembership() membership: Membership, @Query() query: ListMembersQueryDto) {
    return this.organizations.listMembers(membership, query);
  }

  @Patch(':orgId/members/:memberId')
  @UseGuards(OrgMemberGuard)
  @RequirePermission('members.manage')
  @ApiOperation({ summary: "Change a member's role or title" })
  @ApiProblemResponses(403, 404, 409, 422)
  updateMember(
    @CurrentMembership() membership: Membership,
    @Param('memberId', ParseId()) memberId: string,
    @Body() dto: UpdateMemberDto,
  ) {
    return this.organizations.updateMember(membership, memberId, dto);
  }

  @Delete(':orgId/members/:memberId')
  @HttpCode(204)
  @UseGuards(OrgMemberGuard)
  @ApiOperation({ summary: 'Remove a member (members.manage), or leave the organization (own membership)' })
  @ApiProblemResponses(403, 404, 409)
  async removeMember(@CurrentMembership() membership: Membership, @Param('memberId', ParseId()) memberId: string) {
    await this.organizations.removeMember(membership, memberId);
  }
}
