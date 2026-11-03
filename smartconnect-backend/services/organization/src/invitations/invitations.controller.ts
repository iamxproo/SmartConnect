import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses, BEARER_AUTH, CurrentPrincipal, Public, type Principal } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import { CurrentMembership, OrgMemberGuard, RequirePermission, type Membership } from '../access/org-member.guard.js';
import { ParseId } from '../organizations/organizations.controller.js';
import { CreateInvitationDto, InvitationTokenDto, ListInvitationsQueryDto } from './dto.js';
import { InvitationsService } from './invitations.service.js';

@ApiTags('Invitations')
@ApiBearerAuth(BEARER_AUTH)
@Controller('orgs/:orgId/invitations')
@UseGuards(OrgMemberGuard)
@RequirePermission('members.invite')
export class OrganizationInvitationsController {
  constructor(@Inject(InvitationsService) private readonly invitations: InvitationsService) {}

  @Post()
  @ApiOperation({ summary: 'Invite someone by email (the email carries a single-use, expiring link)' })
  @ApiProblemResponses(403, 404, 409, 422)
  create(@CurrentMembership() membership: Membership, @Body() dto: CreateInvitationDto) {
    return this.invitations.create(membership, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Invitations by status (default pending), newest first' })
  @ApiProblemResponses(403, 404, 422)
  list(@CurrentMembership() membership: Membership, @Query() query: ListInvitationsQueryDto) {
    return this.invitations.list(membership, query);
  }

  @Post(':invitationId/resend')
  @HttpCode(200)
  @ApiOperation({ summary: 'New link and expiry for a pending invitation; the old link stops working' })
  @ApiProblemResponses(403, 404, 409)
  resend(@CurrentMembership() membership: Membership, @Param('invitationId', ParseId()) invitationId: string) {
    return this.invitations.resend(membership, invitationId);
  }

  @Delete(':invitationId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke a pending invitation' })
  @ApiProblemResponses(403, 404, 409)
  async revoke(@CurrentMembership() membership: Membership, @Param('invitationId', ParseId()) invitationId: string) {
    await this.invitations.revoke(membership, invitationId);
  }
}

@ApiTags('Invitations')
@Controller('invitations')
export class InvitationAcceptanceController {
  constructor(@Inject(InvitationsService) private readonly invitations: InvitationsService) {}

  @Public()
  @Post('preview')
  @HttpCode(200)
  @ApiOperation({ summary: 'What an invitation is for (organization, role, a hint of the invited address)' })
  @ApiProblemResponses(404, 422)
  preview(@Body() dto: InvitationTokenDto) {
    return this.invitations.preview(dto.token);
  }

  @Post('accept')
  @HttpCode(200)
  @ApiBearerAuth(BEARER_AUTH)
  @ApiOperation({ summary: 'Accept an invitation: the verified account email must be the invited address' })
  @ApiProblemResponses(401, 403, 404, 409, 422)
  accept(@Req() req: Request, @CurrentPrincipal() principal: Principal, @Body() dto: InvitationTokenDto) {
    return this.invitations.accept(req, principal, dto.token);
  }
}
