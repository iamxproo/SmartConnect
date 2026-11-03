import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@smartconnect/backend-kit';
import { withTenant } from '../database/client.js';
import { PRISMA, type OrganizationPrisma } from '../database/prisma.token.js';
import { invalidField } from '../errors.js';
import { decodeCursor, encodeCursor } from '../ids.js';
import type { PageQueryDto } from '../organizations/dto.js';

/**
 * Cross-tenant reads for platform administration (ADR 0015). The only cross-tenant step is the SECURITY DEFINER
 * function organization.platform_organization_ids(), which returns identifiers; each organization is then read inside
 * its own tenant context, like every other read in this service.
 */
@Injectable()
export class AdminService {
  constructor(@Inject(PRISMA) private readonly prisma: OrganizationPrisma) {}

  async listOrganizations(principal: Principal, query: PageQueryDto) {
    const limit = query.limit ?? 50;
    const beforeId = decodeCursor(query.cursor);
    if (query.cursor !== undefined && !beforeId) throw invalidField('cursor', 'invalid_cursor', 'cursor is not valid');
    const [ids, [counted]] = await Promise.all([
      this.prisma.$queryRaw<{ organization_id: string }[]>`
        SELECT organization_id FROM platform_organization_ids(${limit + 1}::int, ${beforeId ?? null}::uuid)`,
      this.prisma.$queryRaw<{ total: bigint }[]>`SELECT platform_organization_count() AS total`,
    ]);
    const page = ids.slice(0, limit);
    const data = [];
    for (const { organization_id: organizationId } of page) {
      const organization = await withTenant(this.prisma, { organizationId, userId: principal.userId }, async (tx) => {
        const org = await tx.organization.findUnique({
          where: { id: organizationId },
          select: { id: true, slug: true, name: true, status: true, createdAt: true },
        });
        return org && { ...org, memberCount: await tx.organizationMember.count({ where: { status: 'active' } }) };
      });
      if (organization) data.push(organization);
    }
    return {
      data,
      total: Number(counted?.total ?? 0),
      nextCursor: ids.length > limit ? encodeCursor(page[page.length - 1]!.organization_id) : null,
    };
  }
}
