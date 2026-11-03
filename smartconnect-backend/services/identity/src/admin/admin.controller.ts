import { Controller, Get, Header, Inject, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses, BEARER_AUTH } from '@smartconnect/backend-kit';
import { PRISMA, type IdentityPrisma } from '../database/prisma.token.js';
import { AccountSummaryDto } from './dto.js';
import { SuperAdminGuard } from './super-admin.guard.js';

/** Platform administration (ADR 0015): read-only, Super Admin only. */
@ApiTags('Platform administration')
@ApiBearerAuth(BEARER_AUTH)
@UseGuards(SuperAdminGuard)
@Controller('admin')
export class AdminController {
  constructor(@Inject(PRISMA) private readonly prisma: IdentityPrisma) {}

  @Get('accounts/summary')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Platform-wide account totals (Super Admin only)' })
  @ApiOkResponse({ type: AccountSummaryDto })
  @ApiProblemResponses(401, 403)
  async summary(): Promise<AccountSummaryDto> {
    const live = { deletedAt: null };
    const [total, verified, byStatus, superAdmins] = await Promise.all([
      this.prisma.user.count({ where: live }),
      this.prisma.user.count({ where: { ...live, emailVerifiedAt: { not: null } } }),
      this.prisma.user.groupBy({ by: ['status'], where: live, _count: { _all: true } }),
      this.prisma.platformRoleAssignment.count({ where: { role: 'super_admin' } }),
    ]);
    const count = (status: string) => byStatus.find((row) => row.status === status)?._count._all ?? 0;
    return {
      total,
      verified,
      active: count('active'),
      suspended: count('suspended'),
      deactivated: count('deactivated'),
      superAdmins,
    };
  }
}
