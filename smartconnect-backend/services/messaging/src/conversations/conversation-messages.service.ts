// Messages of direct and group conversations. Participation is the only way in, and history starts at the caller's
// joinedAt: older messages are neither listed, editable, deletable nor countable for them.
import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { OrganizationDirectory } from '../access/organization-directory.js';
import { FileDirectory } from '../attachments/file-directory.js';
import { conflict, forbidden, invalid, notFound } from '../common/errors.js';
import { withTenant } from '../database/client.js';
import { PRISMA, type MessagingPrisma } from '../database/prisma.token.js';
import { recordEvents, type ConversationEvent, type MessageEvent } from '../events/outbox.js';
import { RealtimePublisher, type ConversationChanged } from '../events/realtime-publisher.js';
import { decodeCursor } from '../messages/cursor.js';
import { isEmoji } from '../messages/emoji.js';
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
} from '../messages/message-store.js';
import { notMentionable, parseMentions, syncMentions } from '../messages/mentions.js';
import {
  advanceReadCursor,
  changed,
  conversationEvent,
  dropStaleParticipants,
  otherOfDirect,
  participantIds,
  requireParticipation,
  type Actor,
  type Me,
  type Tx,
} from './access.js';
import type { ConversationContextDto, ConversationMessageDto, ConversationMessageListDto } from './dto.js';

export interface RepliesPage {
  data: ConversationMessageDto[];
  nextCursor: string | null;
}

const toMessage = (row: MessageRow, conversationId: string, decoration?: Decoration): ConversationMessageDto => {
  const { id, ...rest } = messageFields(row, decoration);
  return { id, conversationId, ...rest };
};

/** Views of rows from this transaction, with their threads, reactions, mentions and bookmarks. */
async function viewsOf(
  tx: Tx,
  actor: Actor,
  rows: MessageRow[],
  conversationId: string,
): Promise<ConversationMessageDto[]> {
  const decorated = await decorations(tx, actor, rows);
  return rows.map((row) => toMessage(row, conversationId, decorated.get(row.id)));
}

/** Only participants can be mentioned in a direct or group conversation. */
async function checkMentions(tx: Tx, actor: Actor, conversationId: string, mentioned: string[]): Promise<void> {
  if (mentioned.length === 0) return;
  const known = await tx.conversationMember.count({
    where: { organizationId: actor.organizationId, conversationId, userId: { in: mentioned } },
  });
  if (known !== mentioned.length) throw notMentionable();
}

const messageEvent = (
  eventType: MessageEvent['eventType'],
  actor: Actor,
  conversationId: string,
  messageId: string,
): MessageEvent => ({
  eventType,
  organizationId: actor.organizationId,
  messageId,
  payload: { messageId, conversationId, actorUserId: actor.userId },
});

@Injectable()
export class ConversationMessagesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: MessagingPrisma,
    @Inject(OrganizationDirectory) private readonly organizations: OrganizationDirectory,
    @Inject(RealtimePublisher) private readonly realtime: RealtimePublisher,
    @Inject(FileDirectory) private readonly files: FileDirectory,
  ) {}

  private async commit<T>(
    actor: Actor,
    fn: (tx: Tx) => Promise<{ value: T; announce: ConversationChanged[] }>,
  ): Promise<T> {
    const { value, announce } = await withTenant(this.prisma, actor, fn);
    for (const event of announce) this.realtime.publishConversationChanged(event);
    return value;
  }

  list(
    actor: Actor,
    conversationId: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<ConversationMessageListDto> {
    const after = decodeCursor(cursor);
    return withTenant(this.prisma, actor, async (tx) => {
      const me = await requireParticipation(tx, actor, conversationId);
      const { rows, nextCursor } = await messagePage(
        tx,
        { organizationId: actor.organizationId, conversationId, notBefore: me.joinedAt },
        limit,
        after,
      );
      return {
        data: await viewsOf(tx, actor, rows, conversationId),
        nextCursor,
        ...(await unreadSummary(tx, actor, conversationId, me.joinedAt)),
      };
    });
  }

  /** Replies of a thread, oldest first. The root must be visible from the caller's join onward. */
  replies(
    actor: Actor,
    conversationId: string,
    rootId: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<RepliesPage> {
    const after = decodeCursor(cursor);
    return withTenant(this.prisma, actor, async (tx) => {
      const { message } = await visibleMessage(tx, actor, conversationId, rootId);
      // The replies of a deleted root are no longer readable.
      if (message.threadRootId || message.deletedAt) throw notFound();
      const scope = { organizationId: actor.organizationId, conversationId, rootId };
      const { rows, nextCursor } = await repliesPage(tx, scope, limit, after);
      return { data: await viewsOf(tx, actor, rows, conversationId), nextCursor };
    });
  }

  /** The message with the messages around it, from the caller's join onward; a reply gives its root's context. */
  context(
    actor: Actor,
    conversationId: string,
    messageId: string,
    before: number,
    after: number,
  ): Promise<ConversationContextDto> {
    return withTenant(this.prisma, actor, async (tx) => {
      const { message, me } = await visibleMessage(tx, actor, conversationId, messageId);
      let target = message;
      if (message.threadRootId) {
        target = (await visibleMessage(tx, actor, conversationId, message.threadRootId)).message;
        if (target.deletedAt) throw notFound();
      }
      const scope = { organizationId: actor.organizationId, conversationId, notBefore: me.joinedAt };
      const rows = await contextRows(tx, scope, target, before, after);
      return {
        data: await viewsOf(tx, actor, rows, conversationId),
        targetId: target.id,
        isReply: target.id !== message.id,
        replyId: target.id !== message.id ? message.id : null,
      };
    });
  }

  /** `created` is false when `clientMessageId` repeats an earlier post: the original message is returned. */
  async post(
    actor: Actor,
    conversationId: string,
    input: { body: string; clientMessageId?: string; threadRootId?: string; attachmentFileIds?: string[] },
    req: Request,
  ): Promise<{ message: ConversationMessageDto; created: boolean }> {
    // Direct conversations: the other person must still be an active member of the organization.
    const known = await withTenant(this.prisma, actor, (tx) => requireParticipation(tx, actor, conversationId));
    const other = known.kind === 'direct' ? otherOfDirect(known.directKey ?? '', actor.userId) : undefined;
    const otherSince = other ? await this.organizations.activeMembers(actor.organizationId, [other], req) : undefined;
    if (other && !otherSince?.has(other))
      throw conflict('participant_inactive', 'The other participant is no longer a member of the organization.');
    // Asked before the transaction, as the caller: no database connection is held while the files service answers.
    const attachments = input.attachmentFileIds?.length
      ? await this.files.snapshots(actor.organizationId, actor.userId, input.attachmentFileIds, req)
      : undefined;

    return this.commit<{ message: ConversationMessageDto; created: boolean }>(actor, async (tx) => {
      const me = await requireParticipation(tx, actor, conversationId);
      const mentioned = parseMentions(input.body);
      await checkMentions(tx, actor, conversationId, mentioned);
      if (input.threadRootId)
        await requireThreadRoot(
          tx,
          { organizationId: actor.organizationId, conversationId, notBefore: me.joinedAt },
          input.threadRootId,
        );
      const events: (MessageEvent | ConversationEvent)[] = [];
      const announce: ConversationChanged[] = [];
      if (other && otherSince) {
        // A pruned (removed and re-invited) partner is re-added, before the message exists: they see it and what follows.
        // Leftovers of their earlier organization membership are dropped first, so they start fresh too.
        await dropStaleParticipants(tx, actor, conversationId, otherSince);
        const { count } = await tx.conversationMember.createMany({
          data: [{ organizationId: actor.organizationId, conversationId, userId: other, joinedAt: new Date() }],
          skipDuplicates: true,
        });
        if (count > 0)
          events.push(conversationEvent('messaging.conversation.participant_added', actor, conversationId, other));
      }
      const { row, created } = await insertMessage(tx, {
        organizationId: actor.organizationId,
        conversationId,
        senderUserId: actor.userId,
        body: input.body,
        clientMessageId: input.clientMessageId,
        threadRootId: input.threadRootId,
        attachments,
      });
      if (created)
        await syncMentions(tx, { organizationId: actor.organizationId, conversationId, messageId: row.id }, mentioned);
      const [message] = await viewsOf(tx, actor, [row], conversationId);
      if (!created) return { value: { message: message!, created }, announce };
      // A top-level post is read by its sender; a reply is not part of the timeline.
      if (!row.threadRootId) await advanceReadCursor(tx, actor, conversationId, row);
      events.push(messageEvent('messaging.message.created', actor, conversationId, row.id));
      await recordEvents(tx, events);
      const recipients = await participantIds(tx, actor, conversationId);
      if (events.length > 1) announce.push(changed('conversation.updated', actor, conversationId, null, recipients));
      announce.push(changed('message.created', actor, conversationId, row.id, recipients));
      // The root's reply count changed.
      if (row.threadRootId)
        announce.push(changed('message.updated', actor, conversationId, row.threadRootId, recipients));
      return { value: { message: message!, created }, announce };
    });
  }

  edit(actor: Actor, conversationId: string, messageId: string, body: string): Promise<ConversationMessageDto> {
    const mentioned = parseMentions(body);
    return this.commit(actor, async (tx) => {
      const { message } = await visibleMessage(tx, actor, conversationId, messageId);
      if (message.senderUserId !== actor.userId) throw forbidden('forbidden', 'Only the sender can edit a message.');
      if (message.deletedAt) throw conflict('message_deleted', 'The message was deleted.');
      await checkMentions(tx, actor, conversationId, mentioned);
      const row = await editMessage(tx, { organizationId: actor.organizationId, conversationId }, messageId, body);
      if (!row) throw conflict('message_deleted', 'The message was deleted.');
      await syncMentions(tx, { organizationId: actor.organizationId, conversationId, messageId }, mentioned);
      await recordEvents(tx, [messageEvent('messaging.message.updated', actor, conversationId, messageId)]);
      return {
        value: (await viewsOf(tx, actor, [row], conversationId))[0]!,
        announce: [
          changed('message.updated', actor, conversationId, messageId, await participantIds(tx, actor, conversationId)),
        ],
      };
    });
  }

  /** Idempotent. Participants may react; a deleted message cannot be reacted to. */
  react(actor: Actor, conversationId: string, messageId: string, emoji: string, on: boolean): Promise<void> {
    if (!isEmoji(emoji)) throw invalid('emoji', 'invalid_emoji', 'A reaction is one emoji of at most 64 bytes.');
    return this.commit(actor, async (tx) => {
      const { message } = await visibleMessage(tx, actor, conversationId, messageId);
      if (message.deletedAt) throw conflict('message_deleted', 'The message was deleted.');
      const moved = on
        ? await addReaction(tx, actor, messageId, emoji)
        : await removeReaction(tx, actor, messageId, emoji);
      return { value: undefined, announce: moved ? [await updated(tx, actor, conversationId, messageId)] : [] };
    });
  }

  /** Idempotent. Saving is private to the caller; the change reaches their other open clients. */
  bookmark(actor: Actor, conversationId: string, messageId: string, saved: boolean): Promise<void> {
    return this.commit(actor, async (tx) => {
      const { message } = await visibleMessage(tx, actor, conversationId, messageId);
      if (saved && message.deletedAt) throw conflict('message_deleted', 'The message was deleted.');
      const moved = await setBookmark(tx, actor, messageId, saved);
      return {
        value: undefined,
        announce: moved ? [changed('message.updated', actor, conversationId, messageId, [actor.userId])] : [],
      };
    });
  }

  /** Idempotent: deleting a deleted message succeeds without a second event. The sender, or a group admin, may delete. */
  remove(actor: Actor, conversationId: string, messageId: string): Promise<void> {
    return this.commit(actor, async (tx) => {
      const { message, me } = await visibleMessage(tx, actor, conversationId, messageId);
      const moderator = me.kind === 'group' && me.role === 'admin';
      if (message.senderUserId !== actor.userId && !moderator)
        throw forbidden('forbidden', 'Only the sender or a group admin can delete a message.');
      if (!(await eraseMessage(tx, { organizationId: actor.organizationId, conversationId }, messageId)))
        return { value: undefined, announce: [] };
      await recordEvents(tx, [messageEvent('messaging.message.deleted', actor, conversationId, messageId)]);
      return {
        value: undefined,
        announce: [
          changed('message.deleted', actor, conversationId, messageId, await participantIds(tx, actor, conversationId)),
        ],
      };
    });
  }
}

const updated = async (tx: Tx, actor: Actor, conversationId: string, messageId: string) =>
  changed('message.updated', actor, conversationId, messageId, await participantIds(tx, actor, conversationId));

/**
 * The message, only if the caller participates and it was created at or after their join (else just not found). A
 * reply also needs its thread root to be visible.
 */
async function visibleMessage(
  tx: Tx,
  actor: Actor,
  conversationId: string,
  messageId: string,
): Promise<{ message: MessageRow; me: Me }> {
  const me = await requireParticipation(tx, actor, conversationId);
  const message = await tx.message.findFirst({
    where: {
      id: messageId,
      organizationId: actor.organizationId,
      conversationId,
      createdAt: { gte: me.joinedAt },
      OR: [{ threadRootId: null }, { threadRoot: { createdAt: { gte: me.joinedAt } } }],
    },
  });
  if (!message) throw notFound();
  return { message, me };
}
