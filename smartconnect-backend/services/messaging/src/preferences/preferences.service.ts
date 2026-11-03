// Per-person notification levels for one conversation (channel conversations included). No row means `all`.
import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { VisibleChannels } from '../search/visible-channels.js';
import type { ChannelAccess } from '../channels/channel-directory.js';
import { requireParticipation, type Actor, type Tx } from '../conversations/access.js';
import { withTenant } from '../database/client.js';
import { PRISMA, type MessagingPrisma } from '../database/prisma.token.js';
import { ensureConversation } from '../messages/messages.service.js';
import type { Level, NotificationPreferenceListDto } from './dto.js';

async function store(tx: Tx, actor: Actor, conversationId: string, level: Level): Promise<void> {
  const where = { conversationId, userId: actor.userId };
  if (level === 'all') {
    await tx.conversationPreference.deleteMany({ where: { ...where, organizationId: actor.organizationId } });
    return;
  }
  await tx.conversationPreference.upsert({
    where: { conversationId_userId: where },
    create: { ...where, organizationId: actor.organizationId, level },
    update: { level },
  });
}

@Injectable()
export class PreferencesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: MessagingPrisma,
    @Inject(VisibleChannels) private readonly channels: VisibleChannels,
  ) {}

  /** The caller already sees the channel (AccessGuard). Its conversation row is created on first need. */
  setForChannel(actor: Actor, channel: ChannelAccess, level: Level): Promise<void> {
    return withTenant(this.prisma, actor, async (tx) => {
      if (level === 'all') {
        const existing = await tx.conversation.findFirst({
          where: { organizationId: actor.organizationId, channelId: channel.channelId },
          select: { id: true },
        });
        if (existing) await store(tx, actor, existing.id, level);
        return;
      }
      await store(tx, actor, await ensureConversation(tx, actor, channel), level);
    });
  }

  /** Participants only; anyone else gets the same 404 as for a missing conversation. */
  setForConversation(actor: Actor, conversationId: string, level: Level): Promise<void> {
    return withTenant(this.prisma, actor, async (tx) => {
      await requireParticipation(tx, actor, conversationId);
      await store(tx, actor, conversationId, level);
    });
  }

  /** The caller's levels other than `all`, leaving out channels they can no longer see and conversations they left. */
  async list(actor: Actor, req: Request): Promise<NotificationPreferenceListDto> {
    const rows = await withTenant(this.prisma, actor, async (tx) => {
      const prefs = await tx.conversationPreference.findMany({
        where: { organizationId: actor.organizationId, userId: actor.userId },
        include: { conversation: true },
        orderBy: { updatedAt: 'desc' },
      });
      const member = await tx.conversationMember.findMany({
        where: { organizationId: actor.organizationId, userId: actor.userId },
        select: { conversationId: true },
      });
      return { prefs, member: new Set(member.map((m) => m.conversationId)) };
    });
    const visible = rows.prefs.some((p) => p.conversation.kind === 'channel')
      ? new Set(await this.channels.idsFor(actor.organizationId, req))
      : new Set<string>();
    const data: NotificationPreferenceListDto['data'] = [];
    for (const { conversation: c, level } of rows.prefs) {
      if (level === 'all') continue;
      if (c.kind === 'channel') {
        if (c.channelId && c.workspaceId && visible.has(c.channelId))
          data.push({ location: { kind: 'channel', workspaceId: c.workspaceId, channelId: c.channelId }, level });
      } else if (rows.member.has(c.id)) {
        data.push({ location: { kind: c.kind, conversationId: c.id }, level });
      }
    }
    return { data };
  }
}
