// Channel messages. Authorization is decided before this service runs (AccessGuard); this layer enforces what
// only the data can: the message belongs to THIS channel's conversation, sender-only edits, idempotency, soft delete.
import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { OrganizationDirectory } from '../access/organization-directory.js';
import { FileDirectory } from '../attachments/file-directory.js';
import type { ChannelAccess } from '../channels/channel-directory.js';
import { advanceReadCursor } from '../conversations/access.js';
import { conflict, forbidden, invalid, notFound } from '../common/errors.js';
import { uuidv7 } from '../common/uuid.js';
import { withTenant, type Prisma } from '../database/client.js';
import { PRISMA, type MessagingPrisma } from '../database/prisma.token.js';
import { recordEvents, type MessageEvent } from '../events/outbox.js';
import { RealtimePublisher } from '../events/realtime-publisher.js';
import { decodeCursor } from './cursor.js';
import type { ContextDto, MessageDto, MessageListDto, RepliesListDto } from './dto.js';
import { isEmoji } from './emoji.js';
import {
  addReaction,
  contextRows,
  decorations,
  editMessage,
  eraseMessage,
  insertMessage,
  messageFields,
  messagePage,
  removeReaction,
  repliesPage,
  requireThreadRoot,
  setBookmark,
  unreadSummary,
  type Decoration,
  type MessageRow,
} from './message-store.js';
import { notMentionable, parseMentions, syncMentions } from './mentions.js';

type Tx = Prisma.TransactionClient;

export interface Actor {
  organizationId: string;
  userId: string;
}

const toMessage = (row: MessageRow, channelId: string, decoration?: Decoration): MessageDto => {
  const { id, ...rest } = messageFields(row, decoration);
  return { id, channelId, ...rest };
};

/** Views of rows from this transaction, with their threads, reactions, mentions and bookmarks. */
async function viewsOf(tx: Tx, actor: Actor, rows: MessageRow[], channelId: string): Promise<MessageDto[]> {
  const decorated = await decorations(tx, actor, rows);
  return rows.map((row) => toMessage(row, channelId, decorated.get(row.id)));
}

@Injectable()
export class MessagesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: MessagingPrisma,
    @Inject(RealtimePublisher) private readonly realtime: RealtimePublisher,
    @Inject(OrganizationDirectory) private readonly organizations: OrganizationDirectory,
    @Inject(FileDirectory) private readonly files: FileDirectory,
  ) {}

  /** Mentions in channels may name any active member of the organization (asked as the caller). */
  private async mentionsOf(body: string, actor: Actor, req: Request): Promise<string[]> {
    const mentioned = parseMentions(body);
    const members = await this.organizations.activeMembers(actor.organizationId, mentioned, req);
    if (mentioned.some((id) => !members.has(id))) throw notMentionable();
    return mentioned;
  }

  async list(actor: Actor, channel: ChannelAccess, limit: number, cursor: string | undefined): Promise<MessageListDto> {
    const after = decodeCursor(cursor);
    return withTenant(this.prisma, actor, async (tx) => {
      const conversation = await tx.conversation.findFirst({
        where: { organizationId: actor.organizationId, channelId: channel.channelId },
        select: { id: true },
      });
      if (!conversation) return { data: [], nextCursor: null, unreadCount: 0, lastReadMessageId: null };
      const { rows, nextCursor } = await messagePage(
        tx,
        { organizationId: actor.organizationId, conversationId: conversation.id },
        limit,
        after,
      );
      return {
        data: await viewsOf(tx, actor, rows, channel.channelId),
        nextCursor,
        ...(await unreadSummary(tx, actor, conversation.id)),
      };
    });
  }

  /** Replies of a thread, oldest first. */
  async replies(
    actor: Actor,
    channel: ChannelAccess,
    rootId: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<RepliesListDto> {
    const after = decodeCursor(cursor);
    return withTenant(this.prisma, actor, async (tx) => {
      const { message, conversationId } = await loadMessage(tx, actor, channel, rootId);
      // The replies of a deleted root are no longer readable.
      if (message.threadRootId || message.deletedAt) throw notFound();
      const scope = { organizationId: actor.organizationId, conversationId, rootId };
      const { rows, nextCursor } = await repliesPage(tx, scope, limit, after);
      return { data: await viewsOf(tx, actor, rows, channel.channelId), nextCursor };
    });
  }

  /** The message with the messages around it; a reply gives its root's context (the root must be readable). */
  async context(
    actor: Actor,
    channel: ChannelAccess,
    messageId: string,
    before: number,
    after: number,
  ): Promise<ContextDto> {
    return withTenant(this.prisma, actor, async (tx) => {
      const { message, conversationId } = await loadMessage(tx, actor, channel, messageId);
      let target = message;
      if (message.threadRootId) {
        target = (await loadMessage(tx, actor, channel, message.threadRootId)).message;
        if (target.deletedAt) throw notFound();
      }
      const scope = { organizationId: actor.organizationId, conversationId };
      const rows = await contextRows(tx, scope, target, before, after);
      return {
        data: await viewsOf(tx, actor, rows, channel.channelId),
        targetId: target.id,
        isReply: target.id !== message.id,
        replyId: target.id !== message.id ? message.id : null,
      };
    });
  }

  /** `created` is false when `clientMessageId` repeats an earlier post: the original message is returned. */
  async post(
    actor: Actor,
    channel: ChannelAccess,
    input: { body: string; clientMessageId?: string; threadRootId?: string; attachmentFileIds?: string[] },
    req: Request,
  ): Promise<{ message: MessageDto; created: boolean }> {
    assertCanPost(channel);
    const mentioned = await this.mentionsOf(input.body, actor, req);
    // Asked before the transaction, as the caller: no database connection is held while the files service answers.
    const attachments = input.attachmentFileIds?.length
      ? await this.files.snapshots(actor.organizationId, actor.userId, input.attachmentFileIds, req)
      : undefined;

    const result = await withTenant(this.prisma, actor, async (tx) => {
      const conversationId = await ensureConversation(tx, actor, channel);
      const scope = { organizationId: actor.organizationId, conversationId };
      if (input.threadRootId) await requireThreadRoot(tx, scope, input.threadRootId);
      const { row, created } = await insertMessage(tx, {
        ...scope,
        senderUserId: actor.userId,
        body: input.body,
        clientMessageId: input.clientMessageId,
        threadRootId: input.threadRootId,
        attachments,
      });
      if (!created) return { message: (await viewsOf(tx, actor, [row], channel.channelId))[0]!, created: false };
      await syncMentions(tx, { ...scope, messageId: row.id }, mentioned);
      // A top-level post is read by its sender; a reply is not part of the timeline.
      if (!row.threadRootId) await advanceReadCursor(tx, actor, conversationId, row);
      await recordEvents(tx, [eventOf('messaging.message.created', actor, channel, conversationId, row.id)]);
      return { message: (await viewsOf(tx, actor, [row], channel.channelId))[0]!, created: true };
    });
    // After the commit, and only for a new message (an idempotent replay changed nothing).
    if (result.created) {
      this.realtime.publish('created', actor, channel, result.message.id);
      // The root's reply count changed.
      if (input.threadRootId) this.realtime.publish('updated', actor, channel, input.threadRootId);
    }
    return result;
  }

  async edit(actor: Actor, channel: ChannelAccess, messageId: string, body: string, req: Request): Promise<MessageDto> {
    const mentioned = await this.mentionsOf(body, actor, req);
    const edited = await withTenant(this.prisma, actor, async (tx) => {
      const { message, conversationId } = await loadMessage(tx, actor, channel, messageId);
      if (message.senderUserId !== actor.userId) throw forbidden('forbidden', 'Only the sender can edit a message.');
      if (message.deletedAt) throw conflict('message_deleted', 'The message was deleted.');
      const row = await editMessage(tx, { organizationId: actor.organizationId, conversationId }, messageId, body);
      if (!row) throw conflict('message_deleted', 'The message was deleted.');
      await syncMentions(tx, { organizationId: actor.organizationId, conversationId, messageId }, mentioned);
      await recordEvents(tx, [eventOf('messaging.message.updated', actor, channel, conversationId, messageId)]);
      return (await viewsOf(tx, actor, [row], channel.channelId))[0]!;
    });
    this.realtime.publish('updated', actor, channel, messageId);
    return edited;
  }

  /** Idempotent. Whoever may post may react (anyone who sees the channel may take a reaction back); a deleted message cannot be reacted to. */
  async react(actor: Actor, channel: ChannelAccess, messageId: string, emoji: string, on: boolean): Promise<void> {
    if (on) assertCanPost(channel);
    if (!isEmoji(emoji)) throw invalid('emoji', 'invalid_emoji', 'A reaction is one emoji of at most 64 bytes.');
    const changed = await withTenant(this.prisma, actor, async (tx) => {
      const { message } = await loadMessage(tx, actor, channel, messageId);
      if (message.deletedAt) throw conflict('message_deleted', 'The message was deleted.');
      return on ? addReaction(tx, actor, messageId, emoji) : removeReaction(tx, actor, messageId, emoji);
    });
    if (changed) this.realtime.publish('updated', actor, channel, messageId);
  }

  /** Idempotent. Saving is private to the caller; anyone who can read the channel may save its messages. */
  async bookmark(actor: Actor, channel: ChannelAccess, messageId: string, saved: boolean): Promise<void> {
    const changed = await withTenant(this.prisma, actor, async (tx) => {
      const { message } = await loadMessage(tx, actor, channel, messageId);
      if (saved && message.deletedAt) throw conflict('message_deleted', 'The message was deleted.');
      return setBookmark(tx, actor, messageId, saved);
    });
    if (changed) this.realtime.publish('updated', actor, channel, messageId);
  }

  /** The read cursor only moves forward. Replies are not part of the timeline, so they cannot be read-marked. */
  async markRead(actor: Actor, channel: ChannelAccess, messageId: string): Promise<void> {
    await withTenant(this.prisma, actor, async (tx) => {
      const { message, conversationId } = await loadMessage(tx, actor, channel, messageId);
      if (message.threadRootId) throw notFound();
      await advanceReadCursor(tx, actor, conversationId, message);
    });
  }

  /** Idempotent: deleting a deleted message succeeds without a second event. */
  async remove(actor: Actor, channel: ChannelAccess, messageId: string): Promise<void> {
    const deleted = await withTenant(this.prisma, actor, async (tx) => {
      const { message, conversationId } = await loadMessage(tx, actor, channel, messageId);
      if (message.senderUserId !== actor.userId && !channel.isAdmin) {
        throw forbidden('forbidden', 'Only the sender or a channel admin can delete a message.');
      }
      const erased = await eraseMessage(tx, { organizationId: actor.organizationId, conversationId }, messageId);
      if (erased) {
        await recordEvents(tx, [eventOf('messaging.message.deleted', actor, channel, conversationId, messageId)]);
      }
      return erased;
    });
    if (deleted) this.realtime.publish('deleted', actor, channel, messageId);
  }
}

function assertCanPost(channel: ChannelAccess): void {
  if (!channel.isMember) throw forbidden('not_a_channel_member', 'Only channel members can post messages.');
  if (channel.archived) throw conflict('channel_archived', 'The channel is archived.');
}

/** The message, only if it lives in this channel's conversation (an id from anywhere else is just not found). */
async function loadMessage(tx: Tx, actor: Actor, channel: ChannelAccess, messageId: string) {
  const conversation = await tx.conversation.findFirst({
    where: { organizationId: actor.organizationId, channelId: channel.channelId },
    select: { id: true },
  });
  if (!conversation) throw notFound();
  const message = await tx.message.findFirst({
    where: { id: messageId, organizationId: actor.organizationId, conversationId: conversation.id },
  });
  if (!message) throw notFound();
  return { message, conversationId: conversation.id };
}

/** Lazily creates the channel's conversation; concurrent first posts converge on the one row (unique channel_id). */
export async function ensureConversation(tx: Tx, actor: Actor, channel: ChannelAccess): Promise<string> {
  const where = { organizationId: actor.organizationId, channelId: channel.channelId };
  const existing = await tx.conversation.findFirst({ where, select: { id: true } });
  if (existing) return existing.id;
  await tx.conversation.createMany({
    data: [
      {
        id: uuidv7(),
        ...where,
        kind: 'channel',
        workspaceId: channel.workspaceId,
        createdByUserId: actor.userId,
      },
    ],
    skipDuplicates: true,
  });
  const created = await tx.conversation.findFirstOrThrow({ where, select: { id: true } });
  return created.id;
}

const eventOf = (
  eventType: MessageEvent['eventType'],
  actor: Actor,
  channel: ChannelAccess,
  conversationId: string,
  messageId: string,
): MessageEvent => ({
  eventType,
  organizationId: actor.organizationId,
  messageId,
  payload: {
    messageId,
    conversationId,
    channelId: channel.channelId,
    workspaceId: channel.workspaceId,
    actorUserId: actor.userId,
  },
});
