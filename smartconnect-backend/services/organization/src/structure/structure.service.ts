// Departments and teams (G-01). Departments are organizational units every member can see; teams carry explicit
// membership, and PRIVATE teams are invisible (404) to everyone except their members.
import { Inject, Injectable } from '@nestjs/common';
import { notFound, type Membership } from '../access/org-member.guard.js';
import { hasPermission } from '../access/permissions.js';
import { type Prisma, withTenant } from '../database/client.js';
import { PRISMA, type OrganizationPrisma } from '../database/prisma.token.js';
import { conflict, forbidden, invalidField, isForeignKeyViolation, isUniqueViolation } from '../errors.js';
import type {
  CreateDepartmentDto,
  CreateTeamDto,
  ListTeamsQueryDto,
  PutTeamMemberDto,
  UpdateDepartmentDto,
  UpdateTeamDto,
} from './dto.js';

/** Upper bound for unpaginated structure lists (departments and teams per organization). */
const MAX_ITEMS = 500;
const MAX_DEPARTMENT_DEPTH = 50;

const departmentSelect = { id: true, name: true, description: true, parentId: true, createdAt: true } as const;
type DepartmentRow = Prisma.DepartmentGetPayload<{ select: typeof departmentSelect }>;
const toDepartment = (row: DepartmentRow) => ({ ...row, createdAt: row.createdAt.toISOString() });

const teamSelect = (userId: string) =>
  ({
    id: true,
    name: true,
    description: true,
    departmentId: true,
    visibility: true,
    createdAt: true,
    _count: { select: { members: true } },
    members: { where: { userId }, select: { role: true } },
  }) as const;
type TeamRow = Prisma.TeamGetPayload<{ select: ReturnType<typeof teamSelect> }>;
const toTeam = (row: TeamRow) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  departmentId: row.departmentId,
  visibility: row.visibility,
  memberCount: row._count.members,
  myRole: row.members[0]?.role ?? null,
  createdAt: row.createdAt.toISOString(),
});

const canManageTeams = (membership: Membership) => hasPermission(membership.role.permissions, 'teams.manage');

/** Teams the caller may see: all for team managers; otherwise public teams and teams the caller belongs to. */
/**
 * Teams the caller may see: public teams and teams the caller belongs to. The same rule for everyone, team managers
 * and owners included: management rights do not open private teams (product rule: admin privileges never expose
 * private content). A manager acts on the teams they can see, and becomes lead of the teams they create.
 */
const visibleTeams = (membership: Membership): Prisma.TeamWhereInput => ({
  OR: [{ visibility: 'public' }, { members: { some: { userId: membership.userId } } }],
});

@Injectable()
export class StructureService {
  constructor(@Inject(PRISMA) private readonly prisma: OrganizationPrisma) {}

  // ---- Departments ------------------------------------------------------------------------------------------------

  async listDepartments(membership: Membership) {
    const rows = await this.tenant(membership, (tx) =>
      tx.department.findMany({ select: departmentSelect, orderBy: { name: 'asc' }, take: MAX_ITEMS }),
    );
    return { data: rows.map(toDepartment) };
  }

  async createDepartment(membership: Membership, input: CreateDepartmentDto) {
    return this.mapStructureErrors('department', () =>
      this.tenant(membership, async (tx) => {
        if (input.parentId) await this.requireDepartment(tx, input.parentId, 'parentId');
        const row = await tx.department.create({
          data: {
            organizationId: membership.organizationId,
            name: input.name,
            description: input.description ?? null,
            parentId: input.parentId ?? null,
            createdByUserId: membership.userId,
          },
          select: departmentSelect,
        });
        return toDepartment(row);
      }),
    );
  }

  async updateDepartment(membership: Membership, departmentId: string, input: UpdateDepartmentDto) {
    return this.mapStructureErrors('department', () =>
      this.tenant(membership, async (tx) => {
        await this.requireDepartment(tx, departmentId);
        if (input.parentId) await this.assertNoCycle(tx, departmentId, input.parentId);
        const row = await tx.department.update({
          where: { id: departmentId },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
          },
          select: departmentSelect,
        });
        return toDepartment(row);
      }),
    );
  }

  async deleteDepartment(membership: Membership, departmentId: string): Promise<void> {
    await this.mapStructureErrors('department', () =>
      this.tenant(membership, async (tx) => {
        await this.requireDepartment(tx, departmentId);
        const [children, teams] = await Promise.all([
          tx.department.count({ where: { parentId: departmentId } }),
          tx.team.count({ where: { departmentId } }),
        ]);
        if (children > 0 || teams > 0) {
          throw conflict('department_not_empty', 'Move or delete its sub-departments and teams first.');
        }
        await tx.department.delete({ where: { id: departmentId } });
      }),
    );
  }

  // ---- Teams ------------------------------------------------------------------------------------------------------

  async listTeams(membership: Membership, query: ListTeamsQueryDto) {
    const rows = await this.tenant(membership, (tx) =>
      tx.team.findMany({
        where: { ...visibleTeams(membership), ...(query.departmentId ? { departmentId: query.departmentId } : {}) },
        select: teamSelect(membership.userId),
        orderBy: { name: 'asc' },
        take: MAX_ITEMS,
      }),
    );
    return { data: rows.map(toTeam) };
  }

  async getTeam(membership: Membership, teamId: string) {
    return this.tenant(membership, async (tx) => toTeam(await this.requireVisibleTeam(tx, membership, teamId)));
  }

  async createTeam(membership: Membership, input: CreateTeamDto) {
    return this.mapStructureErrors('team', () =>
      this.tenant(membership, async (tx) => {
        if (input.departmentId) await this.requireDepartment(tx, input.departmentId, 'departmentId');
        const row = await tx.team.create({
          data: {
            organizationId: membership.organizationId,
            name: input.name,
            description: input.description ?? null,
            departmentId: input.departmentId ?? null,
            visibility: input.visibility,
            createdByUserId: membership.userId,
            // The creator leads the team, so a private team is never created invisible to everyone.
            members: { create: { userId: membership.userId, role: 'lead' } },
          },
          select: teamSelect(membership.userId),
        });
        return toTeam(row);
      }),
    );
  }

  async updateTeam(membership: Membership, teamId: string, input: UpdateTeamDto) {
    return this.mapStructureErrors('team', () =>
      this.tenant(membership, async (tx) => {
        await this.requireVisibleTeam(tx, membership, teamId);
        if (input.departmentId) await this.requireDepartment(tx, input.departmentId, 'departmentId');
        const row = await tx.team.update({
          where: { id: teamId },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
            ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
          },
          select: teamSelect(membership.userId),
        });
        return toTeam(row);
      }),
    );
  }

  async deleteTeam(membership: Membership, teamId: string): Promise<void> {
    await this.tenant(membership, async (tx) => {
      await this.requireVisibleTeam(tx, membership, teamId);
      await tx.team.delete({ where: { id: teamId } });
    });
  }

  async listTeamMembers(membership: Membership, teamId: string) {
    return this.tenant(membership, async (tx) => {
      await this.requireVisibleTeam(tx, membership, teamId);
      const rows = await tx.teamMember.findMany({
        where: { teamId },
        select: { userId: true, role: true, joinedAt: true },
        orderBy: { joinedAt: 'asc' },
        take: MAX_ITEMS,
      });
      // Names come from the organization member projection, in one query.
      const people = await tx.organizationMember.findMany({
        where: { userId: { in: rows.map((row) => row.userId) } },
        select: { userId: true, displayName: true, email: true },
      });
      const byUser = new Map(people.map((person) => [person.userId, person]));
      return {
        data: rows.map((row) => ({
          userId: row.userId,
          displayName: byUser.get(row.userId)?.displayName ?? null,
          email: byUser.get(row.userId)?.email ?? null,
          role: row.role,
          joinedAt: row.joinedAt.toISOString(),
        })),
      };
    });
  }

  /**
   * Adds or updates a team member. Team managers may do anything; a team lead may add plain members and change
   * members (not other leads). The person must be an active member of the organization.
   */
  async putTeamMember(membership: Membership, teamId: string, userId: string, input: PutTeamMemberDto) {
    return this.tenant(membership, async (tx) => {
      const team = await this.requireVisibleTeam(tx, membership, teamId);
      const existing = await tx.teamMember.findUnique({ where: { teamId_userId: { teamId, userId } } });
      if (!canManageTeams(membership)) {
        const lead = team.members[0]?.role === 'lead';
        if (!lead || input.role === 'lead' || existing?.role === 'lead') {
          throw forbidden('Only team managers can assign or change team leads.');
        }
      }
      // FOR SHARE: a concurrent removal from the organization waits for this transaction (and then also deletes the
      // team membership added here), so no team membership can outlive the organization membership.
      const [person] = await tx.$queryRaw<{ displayName: string | null; email: string | null }[]>`
        SELECT display_name AS "displayName", email FROM organization_members
         WHERE user_id = ${userId}::uuid AND status = 'active' FOR SHARE`;
      if (!person)
        throw invalidField('userId', 'user_not_in_organization', 'The user is not a member of this organization');
      const row = await tx.teamMember.upsert({
        where: { teamId_userId: { teamId, userId } },
        create: { organizationId: membership.organizationId, teamId, userId, role: input.role },
        update: { role: input.role },
        select: { userId: true, role: true, joinedAt: true },
      });
      return { ...row, displayName: person.displayName, email: person.email, joinedAt: row.joinedAt.toISOString() };
    });
  }

  /** Team managers remove anyone; leads remove plain members; anyone may leave a team they can see. */
  async removeTeamMember(membership: Membership, teamId: string, userId: string): Promise<void> {
    await this.tenant(membership, async (tx) => {
      const team = await this.requireVisibleTeam(tx, membership, teamId);
      const target = await tx.teamMember.findUnique({ where: { teamId_userId: { teamId, userId } } });
      if (!target) throw notFound();
      const self = userId === membership.userId;
      const lead = team.members[0]?.role === 'lead';
      if (!self && !canManageTeams(membership) && !(lead && target.role === 'member')) {
        throw forbidden('Your role does not allow this action.');
      }
      await tx.teamMember.delete({ where: { id: target.id } });
    });
  }

  // ---- Helpers ----------------------------------------------------------------------------------------------------

  private tenant<T>(membership: Membership, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return withTenant(this.prisma, { organizationId: membership.organizationId, userId: membership.userId }, fn);
  }

  private async requireVisibleTeam(tx: Prisma.TransactionClient, membership: Membership, teamId: string) {
    const team = await tx.team.findFirst({
      where: { id: teamId, ...visibleTeams(membership) },
      select: teamSelect(membership.userId),
    });
    if (!team) throw notFound();
    return team;
  }

  /** Without `field`, a missing department is a 404 (path); with it, a 422 on that field (body reference). */
  private async requireDepartment(tx: Prisma.TransactionClient, departmentId: string, field?: string) {
    const exists = await tx.department.findFirst({ where: { id: departmentId }, select: { id: true } });
    if (exists) return;
    if (field) throw invalidField(field, 'unknown_department', `${field} is not a department of this organization`);
    throw notFound();
  }

  /** Re-parenting must not create a cycle: the new parent may not be the department itself or one of its descendants. */
  private async assertNoCycle(tx: Prisma.TransactionClient, departmentId: string, newParentId: string) {
    let current: string | null = newParentId;
    for (let depth = 0; current !== null; depth++) {
      if (current === departmentId || depth > MAX_DEPARTMENT_DEPTH) {
        throw invalidField('parentId', 'department_cycle', 'A department cannot be nested inside itself');
      }
      const parent: { parentId: string | null } | null = await tx.department.findFirst({
        where: { id: current },
        select: { parentId: true },
      });
      if (!parent)
        throw invalidField('parentId', 'unknown_department', 'parentId is not a department of this organization');
      current = parent.parentId;
    }
  }

  private async mapStructureErrors<T>(kind: 'department' | 'team', fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(`${kind}_name_taken`, `A ${kind} with this name already exists.`);
      if (isForeignKeyViolation(error)) throw conflict(`${kind}_not_empty`, `The ${kind} is still in use.`);
      throw error;
    }
  }
}
