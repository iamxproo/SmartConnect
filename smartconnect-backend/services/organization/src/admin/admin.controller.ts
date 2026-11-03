import { Controller, Get, Header, Inject, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses, BEARER_AUTH, CurrentPrincipal, type Principal } from '@smartconnect/backend-kit';
import { PageQueryDto } from '../organizations/dto.js';
import { AdminService } from './admin.service.js';
import { SuperAdminGuard } from './super-admin.guard.js';

/** Platform administration (ADR 0015): read-only, Super Admin only. */
@ApiTags('Platform administration')
@ApiBearerAuth(BEARER_AUTH)
@UseGuards(SuperAdminGuard)
@Controller('admin')
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}

  @Get('organizations')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Every organization on the platform, newest first (Super Admin only)' })
  @ApiProblemResponses(401, 403, 422)
  organizations(@CurrentPrincipal() principal: Principal, @Query() query: PageQueryDto) {
    return this.admin.listOrganizations(principal, query);
  }
}
