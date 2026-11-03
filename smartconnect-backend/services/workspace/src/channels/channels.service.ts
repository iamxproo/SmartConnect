// Channel visibility rules (docs/api/endpoints.md): a workspace member sees public channels plus the private ones they
// belong to; a workspace guest sees only the channels they belong to. Workspace admin rights confer nothing here:
// a private channel does not exist for anyone who is not in it.
import { Inject, Injectable } from '@nestjs/common';
import { ApiProblemException } from '@smartconnect/backend-kit';
import { forbidden, isUniqueViolation, lastAdmin, notFound } from '../common/errors.js';
import { paginate, type Page } from '../common/pagination.js';
import { nameMatches } from '../common/search.js';
import { lockChannel, type Actor } from '../common/tenant.js';
import { withTenant, type Prisma } from '../database/client.js';
import { PRISMA, type WorkspacePrisma } from '../database/prisma.token.js';
import { loadVisibleWorkspace } from '../workspaces/workspaces.service.js';
import type { WorkspaceRoleValue } from '../workspaces/dto.js';
import type { ChannelDto, ChannelMemberDto, ChannelSearchListDto, ChannelRoleValue, CreateChannelDto } from './dto.js';

type Tx = Prisma.TransactionClient;

interface ChannelRow {
  id: string;
  workspaceId: string;
  name: string;
  topic: string | null;
  description: string | null;
  type: 'public' | 'private';
  isDefault: boolean;
  archivedAt: Date | null;
  createdAt: Date;
}

export const toChannel = (row: ChannelRow, myRole: ChannelRoleValue | null): ChannelDto => ({
  id: row.id,
  workspaceId: row.workspaceId,
  name: row.name,
  topic: row.topic,
  description: row.description,
  type: row.type,
  isDefault: row.isDefault,
  isMember: myRole !== null,
  myRole,
  archivedAt: row.archivedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

/** The caller's role in the workspace; channels do not exist for non-members (404, also for open workspaces). */
async function workspaceRoleOf(tx: Tx, actor: Actor, workspaceId: string): Promise<WorkspaceRoleValue> {
  const { myRole } = await loadVisibleWorkspace(tx, actor, workspaceId);
  if (myRole === null) throw notFound();
  return myRole;
}

const visibleTo = (actor: Actor, workspaceRole: WorkspaceRoleValue): Prisma.ChannelWhereInput =>
  workspaceRole === 'guest'
    ? { members: { some: { userId: actor.userId } } }
    : { OR: [{ type: 'public' }, { members: { some: { userId: actor.userId } } }] };

async function loadChannel(tx: Tx, actor: Actor, workspaceId: string, channelId: string) {
  const workspaceRole = await workspaceRoleOf(tx, actor, workspaceId);
  const channel = await tx.channel.findFirst({
    where: {
      id: channelId,
      workspaceId,
      organizationId: actor.organizationId,
      deletedAt: null,
      ...visibleTo(actor, workspaceRole),
    },
    include: { members: { where: { userId: actor.userId }, select: { role: true }, take: 1 } },
  });
  if (!channel) throw notFound();
  return { channel, workspaceRole, myRole: channel.members[0]?.role ?? null };
}

@Injectable()
export class ChannelsService {
  constructor(@Inject(PRISMA) private readonly prisma: WorkspacePrisma) {}

  async list(actor: Actor, workspaceId: string, { take, afterId }: Page) {
    const rows = await withTenant(this.prisma, actor, async (tx) => {
      const workspaceRole = await workspaceRoleOf(tx, actor, workspaceId);
      return tx.channel.findMany({
        where: {
          workspaceId,
          organizationId: actor.organizationId,
          deletedAt: null,
          ...visibleTo(actor, workspaceRole),
          ...(afterId ? { id: { gt: afterId } } : {}),
        },
        include: { members: { where: { userId: actor.userId }, select: { role: true }, take: 1 } },
        orderBy: { id: 'asc' },
        take: take + 1,
      });
    });
    const page = paginate(rows, take);
    return { data: page.rows.map((row) => toChannel(row, row.members[0]?.role ?? null)), nextCursor: page.nextCursor };
  }

  /**
   * Every channel the caller can see across their workspaces (same rules as `list`, per workspace): channels do not
   * exist outside workspaces the caller belongs to, guests see only their own, private ones only their members.
   * One query, so there is no per-workspace loop and no difference between "hidden" and "absent".
   */
  async listVisible(actor: Actor, q: string | undefined, { take, afterId }: Page): Promise<ChannelSearchListDto> {
    const mine = { some: { userId: actor.userId } };
    const rows = await withTenant(this.prisma, actor, (tx) =>
      tx.channel.findMany({
        where: {
          organizationId: actor.organizationId,
          deletedAt: null,
          workspace: { deletedAt: null, members: mine },
          OR: [
            { type: 'public', workspace: { members: { some: { userId: actor.userId, role: { not: 'guest' } } } } },
            { members: mine },
          ],
          ...nameMatches(q),
          ...(afterId ? { id: { gt: afterId } } : {}),
        },
        select: {
          id: true,
          workspaceId: true,
          name: true,
          type: true,
          archivedAt: true,
          workspace: { select: { name: true } },
          members: { where: { userId: actor.userId }, select: { role: true }, take: 1 },
        },
        orderBy: { id: 'asc' },
        take: take + 1,
      }),
    );
    const page = paginate(rows, take);
    return {
      data: page.rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspaceId,
        workspaceName: row.workspace.name,
        name: row.name,
        type: row.type,
        isMember: row.members.length > 0,
        archivedAt: row.archivedAt?.toISOString() ?? null,
      })),
      nextCursor: page.nextCursor,
    };
  }

  async create(actor: Actor, workspaceId: string, dto: CreateChannelDto): Promise<ChannelDto> {
    try {
      return await withTenant(this.prisma, actor, async (tx) => {
        if ((await workspaceRoleOf(tx, actor, workspaceId)) === 'guest') throw forbidden();
        const channel = await tx.channel.create({
          data: {
            organizationId: actor.organizationId,
            workspaceId,
            name: dto.name,
            topic: dto.topic ?? null,
            description: dto.description ?? null,
            type: dto.type,
            createdByUserId: actor.userId,
          },
        });
        await tx.channelMember.create({
          data: { organizationId: actor.organizationId, channelId: channel.id, userId: actor.userId, role: 'admin' },
        });
        return toChannel(channel, 'admin');
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ApiProblemException(409, 'channel_name_taken', 'A channel with this name already exists.');
      throw error;
    }
  }

  async get(actor: Actor, workspaceId: string, channelId: string): Promise<ChannelDto> {
    return withTenant(this.prisma, actor, async (tx) => {
      const { channel, myRole } = await loadChannel(tx, actor, workspaceId, channelId);
      return toChannel(channel, myRole);
    });
  }

  /** Only public channels can be joined; a private channel is visible (so reachable here) only to its members. */
  async join(actor: Actor, workspaceId: string, channelId: string): Promise<ChannelDto> {
    return withTenant(this.prisma, actor, async (tx) => {
      const { channel, myRole } = await loadChannel(tx, actor, workspaceId, channelId);
      if (myRole !== null) return toChannel(channel, myRole);
      await tx.channelMember.createMany({
        data: [{ organizationId: actor.organizationId, channelId, userId: actor.userId, role: 'member' }],
        skipDuplicates: true,
      });
      return toChannel(channel, 'member');
    });
  }

  async leave(actor: Actor, workspaceId: string, channelId: string): Promise<void> {
    await withTenant(this.prisma, actor, async (tx) => {
      await lockChannel(tx, actor, channelId);
      const { channel } = await loadChannel(tx, actor, workspaceId, channelId);
      await this.removeMember(tx, actor, channel, actor.userId);
    });
  }

  async listMembers(
    actor: Actor,
    workspaceId: string,
    channelId: string,
    { take, afterId }: Page,
  ): Promise<{ data: ChannelMemberDto[]; nextCursor: string | null }> {
    const rows = await withTenant(this.prisma, actor, async (tx) => {
      await loadChannel(tx, actor, workspaceId, channelId);
      return tx.channelMember.findMany({
        where: { organizationId: actor.organizationId, channelId, ...(afterId ? { id: { gt: afterId } } : {}) },
        orderBy: { id: 'asc' },
        take: take + 1,
      });
    });
    const page = paginate(rows, take);
    return {
      data: page.rows.map((row) => ({ userId: row.userId, role: row.role, joinedAt: row.joinedAt.toISOString() })),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Private channels: channel admins manage members. Public channels: any workspace member may add (as `member`);
   * granting or changing roles needs a channel admin. The target must already be in the workspace.
   */
  async putMember(
    actor: Actor,
    workspaceId: string,
    channelId: string,
    userId: string,
    role: ChannelRoleValue | undefined,
  ): Promise<ChannelMemberDto> {
    return withTenant(this.prisma, actor, async (tx) => {
      await lockChannel(tx, actor, channelId);
      const { channel, workspaceRole, myRole } = await loadChannel(tx, actor, workspaceId, channelId);
      const isAdmin = myRole === 'admin';
      if (channel.type === 'private' ? !isAdmin : workspaceRole === 'guest' && !isAdmin) throw forbidden();

      const target = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
      if (!target)
        throw new ApiProblemException(422, 'user_not_in_workspace', 'The user is not a member of this workspace.');

      const existing = await tx.channelMember.findUnique({ where: { channelId_userId: { channelId, userId } } });
      if (!existing) {
        const newRole = role ?? 'member';
        if (newRole === 'admin' && !isAdmin) throw forbidden();
        const created = await tx.channelMember.create({
          data: { organizationId: actor.organizationId, channelId, userId, role: newRole },
        });
        return { userId, role: created.role, joinedAt: created.joinedAt.toISOString() };
      }
      if (role === undefined || role === existing.role)
        return { userId, role: existing.role, joinedAt: existing.joinedAt.toISOString() };
      if (!isAdmin) throw forbidden();
      if (existing.role === 'admin' && channel.type === 'private') {
        const others = await tx.channelMember.count({
          where: { organizationId: actor.organizationId, channelId, role: 'admin', userId: { not: userId } },
        });
        if (others === 0) throw lastAdmin('A private channel needs at least one admin.');
      }
      const updated = await tx.channelMember.update({ where: { id: existing.id }, data: { role } });
      return { userId, role: updated.role, joinedAt: updated.joinedAt.toISOString() };
    });
  }

  /** Channel admin, or self. Idempotent. */
  async deleteMember(actor: Actor, workspaceId: string, channelId: string, userId: string): Promise<void> {
    await withTenant(this.prisma, actor, async (tx) => {
      await lockChannel(tx, actor, channelId);
      const { channel, myRole } = await loadChannel(tx, actor, workspaceId, channelId);
      if (userId !== actor.userId && myRole !== 'admin') throw forbidden();
      await this.removeMember(tx, actor, channel, userId);
    });
  }

  private async removeMember(
    tx: Tx,
    actor: Actor,
    channel: { id: string; type: 'public' | 'private' },
    userId: string,
  ): Promise<void> {
    const member = await tx.channelMember.findUnique({
      where: { channelId_userId: { channelId: channel.id, userId } },
    });
    if (!member) return;
    if (channel.type === 'private' && member.role === 'admin') {
      const otherAdmins = await tx.channelMember.count({
        where: { organizationId: actor.organizationId, channelId: channel.id, role: 'admin', userId: { not: userId } },
      });
      const otherMembers = await tx.channelMember.count({
        where: { organizationId: actor.organizationId, channelId: channel.id, userId: { not: userId } },
      });
      if (otherAdmins === 0 && otherMembers > 0) throw lastAdmin('A private channel needs at least one admin.');
    }
    await tx.channelMember.delete({ where: { id: member.id } });
  }
}
