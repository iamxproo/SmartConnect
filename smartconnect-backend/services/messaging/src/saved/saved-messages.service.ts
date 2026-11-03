// The caller's saved messages. A bookmark is not a grant: visibility is decided again on every read, so a message the
// caller can no longer see (lost channel access, removed from the conversation, history from join) is left out and its
// content never leaves this service.
import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ApiProblemException } from '@smartconnect/backend-kit';
import { ChannelDirectory } from '../channels/channel-directory.js';
import { withTenant } from '../database/client.js';
import { PRISMA, type MessagingPrisma } from '../database/prisma.token.js';
import { decodeCursor, encodeCursor } from '../messages/cursor.js';
import { decorations, messageFields } from '../messages/message-store.js';
import type { SavedMessageListDto } from './dto.js';

interface Actor {
  organizationId: string;
  userId: string;
}

/** Bookmarks examined per query, and queries per request: bounds the work when most saved messages are hidden. */
const MAX_ROUNDS = 4;
/** Concurrent workspace-service calls. */
const CHANNEL_CHECKS = 8;
/** Distinct channels asked about per request: a page that would need more is cut short and continued by its cursor. */
export const MAX_CHANNEL_CHECKS_PER_REQUEST = 20;

@Injectable()
export class SavedMessagesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: MessagingPrisma,
    @Inject(ChannelDirectory) private readonly channels: ChannelDirectory,
  ) {}

  async list(actor: Actor, limit: number, cursor: string | undefined, req: Request): Promise<SavedMessageListDto> {
    let after = decodeCursor(cursor);
    // Channel visibility is asked once per distinct channel for the whole request.
    const channelVisible = new Map<string, boolean>();
    const data: SavedMessageListDto['data'] = [];
    let nextCursor: string | null = null;
    let budget = MAX_CHANNEL_CHECKS_PER_REQUEST;

    for (let round = 0; round < MAX_ROUNDS && data.length < limit; round++) {
      const want = limit - data.length;
      const page = await withTenant(this.prisma, actor, async (tx) => {
        const bookmarks = await tx.messageBookmark.findMany({
          where: {
            organizationId: actor.organizationId,
            userId: actor.userId,
            // A reply of a deleted thread root is no longer readable either.
            message: { deletedAt: null, OR: [{ threadRootId: null }, { threadRoot: { deletedAt: null } }] },
            ...(after && {
              OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, messageId: { lt: after.id } }],
            }),
          },
          orderBy: [{ createdAt: 'desc' }, { messageId: 'desc' }],
          take: want + 1,
          include: { message: { include: { conversation: true, threadRoot: { select: { createdAt: true } } } } },
        });
        const batch = bookmarks.slice(0, want);
        const memberships = await tx.conversationMember.findMany({
          where: {
            organizationId: actor.organizationId,
            userId: actor.userId,
            conversationId: { in: batch.map((b) => b.message.conversationId) },
          },
          select: { conversationId: true, joinedAt: true },
        });
        return { bookmarks, batch, joined: new Map(memberships.map((m) => [m.conversationId, m.joinedAt])) };
      });

      // Cut the batch where it would need more channel checks than the request has left.
      const unknown = new Map<string, { workspaceId: string; channelId: string }>();
      let cut = page.batch.length;
      for (const [i, { message }] of page.batch.entries()) {
        const { channelId, workspaceId } = message.conversation;
        if (!channelId || !workspaceId || channelVisible.has(channelId) || unknown.has(channelId)) continue;
        if (unknown.size >= budget) {
          cut = i;
          break;
        }
        unknown.set(channelId, { workspaceId, channelId });
      }
      budget -= unknown.size;
      const batch = page.batch.slice(0, cut);
      const pending = [...unknown.values()];
      for (let i = 0; i < pending.length; i += CHANNEL_CHECKS) {
        await Promise.all(
          pending.slice(i, i + CHANNEL_CHECKS).map(async ({ workspaceId, channelId }) => {
            channelVisible.set(channelId, await this.canSee(actor.organizationId, workspaceId, channelId, req));
          }),
        );
      }

      const visible = batch.filter(({ message }) => {
        const { channelId } = message.conversation;
        if (channelId) return channelVisible.get(channelId) === true;
        const joined = page.joined.get(message.conversationId);
        return (
          joined !== undefined && message.createdAt >= joined && (message.threadRoot?.createdAt ?? joined) >= joined
        );
      });
      const decorated = await withTenant(this.prisma, actor, (tx) =>
        decorations(
          tx,
          actor,
          visible.map((b) => b.message),
        ),
      );
      for (const bookmark of visible) {
        const { conversation, ...row } = bookmark.message;
        data.push({
          ...messageFields(row, decorated.get(row.id)),
          conversationId: conversation.id,
          kind: conversation.kind,
          channelId: conversation.channelId,
          workspaceId: conversation.workspaceId,
          savedAt: bookmark.createdAt.toISOString(),
        });
      }

      const last = batch[batch.length - 1];
      if (last) after = { createdAt: last.createdAt, id: last.messageId };
      if (cut < page.batch.length) {
        // Partial page: the rest is reached through the cursor.
        nextCursor = after ? encodeCursor(after) : null;
        break;
      }
      if (page.bookmarks.length <= want) {
        nextCursor = null;
        break;
      }
      nextCursor = encodeCursor(after!);
    }
    return { data, nextCursor };
  }

  /** The workspace service answers as the caller: 404 hides the channel; anything else unexpected fails the request. */
  private async canSee(orgId: string, workspaceId: string, channelId: string, req: Request): Promise<boolean> {
    try {
      await this.channels.accessTo(orgId, workspaceId, channelId, req);
      return true;
    } catch (error) {
      if (error instanceof ApiProblemException && error.getStatus() === 404) return false;
      throw error;
    }
  }
}
