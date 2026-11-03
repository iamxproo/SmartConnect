import { Inject, Injectable } from '@nestjs/common';
import { ApiProblemException } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import { forbidden, isUniqueViolation, lastAdmin, notFound } from '../common/errors.js';
import { paginate, type Page } from '../common/pagination.js';
import { nameMatches } from '../common/search.js';
import { lockWorkspace, type Actor } from '../common/tenant.js';
import { withTenant, type Prisma } from '../database/client.js';
import { PRISMA, type WorkspacePrisma } from '../database/prisma.token.js';
import { OrganizationDirectory } from '../org/organization-directory.js';
import type {
  CreateWorkspaceDto,
  UpdateWorkspaceDto,
  WorkspaceDto,
  WorkspaceMemberDto,
  WorkspaceRoleValue,
} from './dto.js';

type Tx = Prisma.TransactionClient;

interface WorkspaceRow {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  description: string | null;
  visibility: 'open' | 'private';
  archivedAt: Date | null;
  createdAt: Date;
}

export const toWorkspace = (row: WorkspaceRow, myRole: WorkspaceRoleValue | null): WorkspaceDto => ({
  id: row.id,
  organizationId: row.organizationId,
  name: row.name,
  slug: row.slug,
  description: row.description,
  visibility: row.visibility,
  myRole,
  archivedAt: row.archivedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

/**
 * The workspace if the caller may see it: open ones to any organization member, private ones only to their members.
 * Otherwise 404 (no existence oracle). `myRole` is null for a non-member of an open workspace.
 */
export async function loadVisibleWorkspace(tx: Tx, actor: Actor, workspaceId: string) {
  const workspace = await tx.workspace.findFirst({
    where: {
      id: workspaceId,
      organizationId: actor.organizationId,
      deletedAt: null,
      OR: [{ visibility: 'open' }, { members: { some: { userId: actor.userId } } }],
    },
    include: { members: { where: { userId: actor.userId }, select: { role: true }, take: 1 } },
  });
  if (!workspace) throw notFound();
  return { workspace, myRole: workspace.members[0]?.role ?? null };
}

/** Private channels of the workspace where `userId` is the only admin but other members would remain. */
async function soleAdminPrivateChannels(tx: Tx, actor: Actor, workspaceId: string, userId: string) {
  const channels = await tx.channel.findMany({
    where: {
      organizationId: actor.organizationId,
      workspaceId,
      type: 'private',
      deletedAt: null,
      AND: [
        { members: { some: { userId, role: 'admin' } } },
        { members: { none: { role: 'admin', userId: { not: userId } } } },
        { members: { some: { userId: { not: userId } } } },
      ],
    },
    select: { id: true },
  });
  return channels.map((channel) => channel.id);
}

const DEFAULT_CHANNELS_FOR_NEW_MEMBER = { isDefault: true, type: 'public', deletedAt: null } as const;

@Injectable()
export class WorkspacesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: WorkspacePrisma,
    @Inject(OrganizationDirectory) private readonly directory: OrganizationDirectory,
  ) {}

  async list(actor: Actor, q: string | undefined, { take, afterId }: Page) {
    const rows = await withTenant(this.prisma, actor, (tx) =>
      tx.workspace.findMany({
        where: {
          organizationId: actor.organizationId,
          deletedAt: null,
          OR: [{ visibility: 'open' }, { members: { some: { userId: actor.userId } } }],
          ...nameMatches(q),
          ...(afterId ? { id: { gt: afterId } } : {}),
        },
        include: { members: { where: { userId: actor.userId }, select: { role: true }, take: 1 } },
        orderBy: { id: 'asc' },
        take: take + 1,
      }),
    );
    const page = paginate(rows, take);
    return {
      data: page.rows.map((row) => toWorkspace(row, row.members[0]?.role ?? null)),
      nextCursor: page.nextCursor,
    };
  }

  /** Workspace, admin membership, default channel `general` and its admin membership: all or nothing. */
  async create(actor: Actor, dto: CreateWorkspaceDto): Promise<WorkspaceDto> {
    try {
      return await withTenant(this.prisma, actor, async (tx) => {
        const workspace = await tx.workspace.create({
          data: {
            organizationId: actor.organizationId,
            name: dto.name,
            slug: dto.slug,
            description: dto.description ?? null,
            visibility: dto.visibility,
            createdByUserId: actor.userId,
          },
        });
        await tx.workspaceMember.create({
          data: {
            organizationId: actor.organizationId,
            workspaceId: workspace.id,
            userId: actor.userId,
            role: 'admin',
          },
        });
        const general = await tx.channel.create({
          data: {
            organizationId: actor.organizationId,
            workspaceId: workspace.id,
            name: 'general',
            type: 'public',
            isDefault: true,
            createdByUserId: actor.userId,
          },
        });
        await tx.channelMember.create({
          data: { organizationId: actor.organizationId, channelId: general.id, userId: actor.userId, role: 'admin' },
        });
        return toWorkspace(workspace, 'admin');
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ApiProblemException(409, 'slug_taken', 'A workspace with this slug already exists.');
      throw error;
    }
  }

  async get(actor: Actor, workspaceId: string): Promise<WorkspaceDto> {
    return withTenant(this.prisma, actor, async (tx) => {
      const { workspace, myRole } = await loadVisibleWorkspace(tx, actor, workspaceId);
      return toWorkspace(workspace, myRole);
    });
  }

  async update(actor: Actor, workspaceId: string, dto: UpdateWorkspaceDto): Promise<WorkspaceDto> {
    return withTenant(this.prisma, actor, async (tx) => {
      const { myRole } = await loadVisibleWorkspace(tx, actor, workspaceId);
      if (myRole !== 'admin') throw forbidden();
      const updated = await tx.workspace.update({
        where: { organizationId_id: { organizationId: actor.organizationId, id: workspaceId } },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.visibility !== undefined ? { visibility: dto.visibility } : {}),
        },
      });
      return toWorkspace(updated, 'admin');
    });
  }

  /** Joining an open workspace also joins its default channels; a repeat (or racing) join changes nothing. */
  async join(actor: Actor, workspaceId: string): Promise<WorkspaceDto> {
    return withTenant(this.prisma, actor, async (tx) => {
      const { workspace, myRole } = await loadVisibleWorkspace(tx, actor, workspaceId);
      if (myRole !== null) return toWorkspace(workspace, myRole);
      await this.addMember(tx, actor, workspaceId, actor.userId, 'member');
      return toWorkspace(workspace, 'member');
    });
  }

  async leave(actor: Actor, workspaceId: string): Promise<void> {
    await withTenant(this.prisma, actor, async (tx) => {
      await lockWorkspace(tx, actor, workspaceId);
      await loadVisibleWorkspace(tx, actor, workspaceId);
      await this.removeMember(tx, actor, workspaceId, actor.userId);
    });
  }

  async listMembers(actor: Actor, workspaceId: string, { take, afterId }: Page) {
    const rows = await withTenant(this.prisma, actor, async (tx) => {
      const { myRole } = await loadVisibleWorkspace(tx, actor, workspaceId);
      if (myRole === null) throw forbidden();
      return tx.workspaceMember.findMany({
        where: { organizationId: actor.organizationId, workspaceId, ...(afterId ? { id: { gt: afterId } } : {}) },
        orderBy: { id: 'asc' },
        take: take + 1,
      });
    });
    const page = paginate(rows, take);
    return {
      data: page.rows.map((row) => ({
        userId: row.userId,
        role: row.role,
        joinedAt: row.joinedAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  /** Adds or changes the role of an organization member. The organization check is an HTTP call, so it runs between
   *  two short transactions rather than inside one. */
  async putMember(
    actor: Actor,
    workspaceId: string,
    userId: string,
    role: WorkspaceRoleValue,
    req: Request,
  ): Promise<WorkspaceMemberDto> {
    await withTenant(this.prisma, actor, async (tx) => {
      const { myRole } = await loadVisibleWorkspace(tx, actor, workspaceId);
      if (myRole !== 'admin') throw forbidden();
    });
    if (!(await this.directory.isMember(actor.organizationId, userId, req)))
      throw new ApiProblemException(422, 'user_not_in_organization', 'The user is not a member of this organization.');

    return withTenant(this.prisma, actor, async (tx) => {
      await lockWorkspace(tx, actor, workspaceId);
      const { myRole } = await loadVisibleWorkspace(tx, actor, workspaceId);
      if (myRole !== 'admin') throw forbidden();
      const existing = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
      if (!existing) {
        const created = await this.addMember(tx, actor, workspaceId, userId, role);
        return { userId, role: created.role, joinedAt: created.joinedAt.toISOString() };
      }
      if (existing.role === 'admin' && role !== 'admin') await this.assertOtherAdmin(tx, actor, workspaceId, userId);
      const updated = await tx.workspaceMember.update({ where: { id: existing.id }, data: { role } });
      return { userId, role: updated.role, joinedAt: updated.joinedAt.toISOString() };
    });
  }

  /** Idempotent: removing a non-member is a no-op. */
  async deleteMember(actor: Actor, workspaceId: string, userId: string): Promise<void> {
    await withTenant(this.prisma, actor, async (tx) => {
      await lockWorkspace(tx, actor, workspaceId);
      const { myRole } = await loadVisibleWorkspace(tx, actor, workspaceId);
      if (myRole !== 'admin') throw forbidden();
      await this.removeMember(tx, actor, workspaceId, userId);
    });
  }

  /** New members (however they arrive) are joined to the default public channels. Racing inserts are no-ops. */
  private async addMember(tx: Tx, actor: Actor, workspaceId: string, userId: string, role: WorkspaceRoleValue) {
    const { count } = await tx.workspaceMember.createMany({
      data: [{ organizationId: actor.organizationId, workspaceId, userId, role }],
      skipDuplicates: true,
    });
    const member = await tx.workspaceMember.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (count === 1) {
      const channels = await tx.channel.findMany({
        where: { organizationId: actor.organizationId, workspaceId, ...DEFAULT_CHANNELS_FOR_NEW_MEMBER },
        select: { id: true },
      });
      await tx.channelMember.createMany({
        data: channels.map((channel) => ({
          organizationId: actor.organizationId,
          channelId: channel.id,
          userId,
          role: 'member' as const,
        })),
        skipDuplicates: true,
      });
    }
    return member;
  }

  private async assertOtherAdmin(tx: Tx, actor: Actor, workspaceId: string, userId: string): Promise<void> {
    const others = await tx.workspaceMember.count({
      where: { organizationId: actor.organizationId, workspaceId, role: 'admin', userId: { not: userId } },
    });
    if (others === 0) throw lastAdmin('A workspace needs at least one admin.');
  }

  /**
   * Leaving (self) and removal (by an admin) share this. The caller holds the workspace lock. Channel memberships in
   * the workspace go with it. A private channel left without an admin keeps working: when the user leaves it
   * themselves that is refused (they know the channel); when an admin removes them, the longest-standing remaining
   * member is promoted, so the refusal cannot reveal a private channel to a workspace admin.
   */
  private async removeMember(tx: Tx, actor: Actor, workspaceId: string, userId: string): Promise<void> {
    const member = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
    if (!member) return;
    if (member.role === 'admin') await this.assertOtherAdmin(tx, actor, workspaceId, userId);

    const orphaned = await soleAdminPrivateChannels(tx, actor, workspaceId, userId);
    if (orphaned.length > 0) {
      if (userId === actor.userId)
        throw lastAdmin('You are the only admin of a private channel that has other members.');
      await tx.$executeRaw`UPDATE "workspace"."channel_members" SET role = 'admin', updated_at = now()
        WHERE id IN (SELECT DISTINCT ON (channel_id) id FROM "workspace"."channel_members"
                     WHERE channel_id = ANY(${orphaned}::uuid[]) AND user_id <> ${userId}::uuid
                     ORDER BY channel_id, joined_at, id)`;
    }

    await tx.channelMember.deleteMany({
      where: { organizationId: actor.organizationId, userId, channel: { workspaceId } },
    });
    await tx.workspaceMember.delete({ where: { id: member.id } });
  }
}
