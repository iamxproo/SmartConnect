// Message rows shared by channel and conversation messages: the keyset page, the idempotent insert, the guarded edit
// and delete, and what hangs off a message (thread summary, reactions, mentions, bookmarks). Who may do what is decided
// by the callers.
import type { AttachmentSnapshot } from '../attachments/file-directory.js';
import { conflict, invalid, notFound } from '../common/errors.js';
import { uuidv7 } from '../common/uuid.js';
import type { Prisma } from '../database/client.js';
import { encodeCursor, type TimelinePosition } from './cursor.js';

type Tx = Prisma.TransactionClient;

/** The thread summary lists the first repliers only. */
const MAX_THREAD_PARTICIPANTS = 20;
/** Distinct emoji on one message. */
export const MAX_REACTIONS_PER_MESSAGE = 20;
/** Saved messages per person per organization. */
export const MAX_BOOKMARKS_PER_USER = 500;

export interface MessageRow {
  id: string;
  senderUserId: string | null;
  type: 'standard' | 'system';
  body: string;
  clientMessageId: string | null;
  threadRootId: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

export interface ThreadSummary {
  replyCount: number;
  lastReplyAt: string | null;
  participantUserIds: string[];
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  /** The caller has reacted with it. */
  reacted: boolean;
}

/** What hangs off a message, as the caller sees it. */
export interface Decoration {
  thread: ThreadSummary | null;
  reactions: ReactionSummary[];
  mentionedUserIds: string[];
  bookmarked: boolean;
  attachments: AttachmentSnapshot[];
}

const NO_DECORATION: Decoration = {
  thread: null,
  reactions: [],
  mentionedUserIds: [],
  bookmarked: false,
  attachments: [],
};

/** The fields every message view shares; the caller adds the parent id (channelId or conversationId). */
export const messageFields = (row: MessageRow, decoration: Decoration = NO_DECORATION) => ({
  id: row.id,
  senderUserId: row.senderUserId,
  type: row.type,
  body: row.deletedAt ? null : row.body,
  clientMessageId: row.clientMessageId,
  threadRootId: row.threadRootId,
  createdAt: row.createdAt.toISOString(),
  editedAt: row.editedAt?.toISOString() ?? null,
  deletedAt: row.deletedAt?.toISOString() ?? null,
  ...decoration,
});

/**
 * Thread summaries, reactions, mentions, attachments and the caller's bookmarks for a page of messages: five queries
 * however many messages there are. A deleted message has no reactions, mentions or attachments (erased with the
 * body) and shows no thread summary (its replies are no longer readable).
 */
export async function decorations(
  tx: Tx,
  actor: { organizationId: string; userId: string },
  rows: MessageRow[],
): Promise<Map<string, Decoration>> {
  const result = new Map<string, Decoration>();
  if (rows.length === 0) return result;
  const { organizationId, userId } = actor;
  const messageIds = rows.map((row) => row.id);
  const [threads, reactions, mentions, bookmarks, attachments] = await Promise.all([
    tx.messageThread.findMany({ where: { organizationId, rootMessageId: { in: messageIds } } }),
    tx.$queryRaw<{ message_id: string; emoji: string; n: number; reacted: boolean }[]>`
      SELECT message_id, emoji, count(*)::int AS n, bool_or(user_id = ${userId}::uuid) AS reacted
      FROM messaging.message_reactions
      WHERE organization_id = ${organizationId}::uuid AND message_id = ANY(${messageIds}::uuid[])
      GROUP BY message_id, emoji ORDER BY min(created_at), emoji`,
    tx.messageMention.findMany({
      where: { organizationId, messageId: { in: messageIds }, kind: 'user' },
      select: { messageId: true, mentionedUserId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    tx.messageBookmark.findMany({
      where: { organizationId, userId, messageId: { in: messageIds } },
      select: { messageId: true },
    }),
    tx.messageAttachment.findMany({
      where: { organizationId, messageId: { in: messageIds } },
      select: { messageId: true, fileId: true, name: true, mimeType: true, sizeBytes: true },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    }),
  ]);
  for (const id of messageIds)
    result.set(id, { ...NO_DECORATION, reactions: [], mentionedUserIds: [], attachments: [] });
  const deleted = new Set(rows.filter((row) => row.deletedAt).map((row) => row.id));
  for (const t of threads) {
    if (t.replyCount <= 0 || deleted.has(t.rootMessageId)) continue;
    result.get(t.rootMessageId)!.thread = {
      replyCount: t.replyCount,
      lastReplyAt: t.lastReplyAt?.toISOString() ?? null,
      participantUserIds: t.participantUserIds,
    };
  }
  for (const r of reactions) {
    if (deleted.has(r.message_id)) continue;
    result.get(r.message_id)!.reactions.push({ emoji: r.emoji, count: r.n, reacted: r.reacted });
  }
  for (const m of mentions) result.get(m.messageId)!.mentionedUserIds.push(m.mentionedUserId!);
  for (const b of bookmarks) result.get(b.messageId)!.bookmarked = true;
  for (const a of attachments) {
    // Rows written before the snapshot existed have no metadata: shown as an unnamed file.
    result.get(a.messageId)!.attachments.push({
      fileId: a.fileId,
      name: a.name ?? 'file',
      mimeType: a.mimeType ?? 'application/octet-stream',
      sizeBytes: Number(a.sizeBytes ?? 0),
    });
  }
  return result;
}

/** Newest-first page of top-level messages; `notBefore` hides everything older (history starts at the join). */
export async function messagePage(
  tx: Tx,
  scope: { organizationId: string; conversationId: string; notBefore?: Date },
  limit: number,
  after: TimelinePosition | undefined,
): Promise<{ rows: MessageRow[]; nextCursor: string | null }> {
  const rows = await tx.message.findMany({
    where: {
      organizationId: scope.organizationId,
      conversationId: scope.conversationId,
      threadRootId: null,
      ...(scope.notBefore && { createdAt: { gte: scope.notBefore } }),
      ...(after && {
        AND: [{ OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] }],
      }),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  return { rows: page, nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null };
}

/**
 * Top-level messages around a timeline position, oldest first: up to `before` older ones, the target, and up to
 * `after` newer ones. `notBefore` hides everything older (history starts at the join).
 */
export async function contextRows(
  tx: Tx,
  scope: { organizationId: string; conversationId: string; notBefore?: Date },
  target: MessageRow,
  before: number,
  after: number,
): Promise<MessageRow[]> {
  const base = { organizationId: scope.organizationId, conversationId: scope.conversationId, threadRootId: null };
  const [older, newer] = await Promise.all([
    before === 0
      ? []
      : tx.message.findMany({
          where: {
            ...base,
            ...(scope.notBefore && { createdAt: { gte: scope.notBefore } }),
            AND: [
              {
                OR: [{ createdAt: { lt: target.createdAt } }, { createdAt: target.createdAt, id: { lt: target.id } }],
              },
            ],
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: before,
        }),
    after === 0
      ? []
      : tx.message.findMany({
          where: {
            ...base,
            AND: [
              {
                OR: [{ createdAt: { gt: target.createdAt } }, { createdAt: target.createdAt, id: { gt: target.id } }],
              },
            ],
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: after,
        }),
  ]);
  return [...older.reverse(), target, ...newer];
}

/** Oldest-first page of a thread's replies. */
export async function repliesPage(
  tx: Tx,
  scope: { organizationId: string; conversationId: string; rootId: string },
  limit: number,
  after: TimelinePosition | undefined,
): Promise<{ rows: MessageRow[]; nextCursor: string | null }> {
  const rows = await tx.message.findMany({
    where: {
      organizationId: scope.organizationId,
      conversationId: scope.conversationId,
      threadRootId: scope.rootId,
      ...(after && {
        AND: [{ OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] }],
      }),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  return { rows: page, nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null };
}

/**
 * The thread root a reply names, if the caller may see it: a message of this conversation (older than `notBefore`
 * hides it). 404 when it is not visible, 422 when it is itself a reply, 409 when it was deleted.
 */
export async function requireThreadRoot(
  tx: Tx,
  scope: { organizationId: string; conversationId: string; notBefore?: Date },
  rootId: string,
): Promise<MessageRow> {
  const root = await tx.message.findFirst({
    where: {
      id: rootId,
      organizationId: scope.organizationId,
      conversationId: scope.conversationId,
      ...(scope.notBefore && { createdAt: { gte: scope.notBefore } }),
    },
  });
  if (!root) throw notFound();
  if (root.threadRootId) throw invalid('threadRootId', 'reply_to_reply', 'Replies cannot be replied to.');
  if (root.deletedAt) throw conflict('message_deleted', 'The message was deleted.');
  return root;
}

/** `created` is false when `clientMessageId` repeats an earlier post: the original row is returned. */
export async function insertMessage(
  tx: Tx,
  input: {
    organizationId: string;
    conversationId: string;
    senderUserId: string;
    body: string;
    clientMessageId?: string;
    /** A reply: the thread summary is updated in the same transaction and the timeline is untouched. */
    threadRootId?: string;
    /** Validated snapshots of the files to attach, in order. */
    attachments?: AttachmentSnapshot[];
  },
): Promise<{ row: MessageRow; created: boolean }> {
  const { organizationId, conversationId, senderUserId } = input;
  const createdAt = new Date();
  const id = uuidv7(createdAt.getTime());
  // ON CONFLICT DO NOTHING instead of catching the unique violation: a failed statement would abort the
  // transaction. A concurrent insert of the same key makes this one wait, then skip.
  const { count } = await tx.message.createMany({
    data: [
      {
        id,
        organizationId,
        conversationId,
        senderUserId,
        body: input.body,
        clientMessageId: input.clientMessageId ?? null,
        threadRootId: input.threadRootId ?? null,
        createdAt,
      },
    ],
    skipDuplicates: true,
  });
  if (count === 0) {
    const original = await tx.message.findFirst({
      where: { organizationId, conversationId, senderUserId, clientMessageId: input.clientMessageId ?? '' },
    });
    if (!original) throw new Error('message insert skipped without a matching idempotency key');
    return { row: original, created: false };
  }
  const row = await tx.message.findFirstOrThrow({ where: { id, organizationId } });
  if (input.attachments?.length) {
    await tx.messageAttachment.createMany({
      data: input.attachments.map((a, position) => ({
        organizationId,
        messageId: id,
        fileId: a.fileId,
        position,
        name: a.name,
        mimeType: a.mimeType,
        sizeBytes: BigInt(a.sizeBytes),
      })),
    });
  }
  if (input.threadRootId) {
    // One atomic upsert: concurrent replies queue on the thread row, so the count never loses an increment.
    await tx.$executeRaw`
      INSERT INTO messaging.message_threads
        (root_message_id, organization_id, conversation_id, reply_count, last_reply_at, participant_user_ids, updated_at)
      VALUES (${input.threadRootId}::uuid, ${organizationId}::uuid, ${conversationId}::uuid, 1, ${createdAt}::timestamptz,
              ARRAY[${senderUserId}::uuid], now())
      ON CONFLICT (root_message_id) DO UPDATE
        SET reply_count = message_threads.reply_count + 1,
            last_reply_at = GREATEST(message_threads.last_reply_at, EXCLUDED.last_reply_at),
            participant_user_ids = CASE
              WHEN ${senderUserId}::uuid = ANY(message_threads.participant_user_ids)
                OR cardinality(message_threads.participant_user_ids) >= ${MAX_THREAD_PARTICIPANTS}
              THEN message_threads.participant_user_ids
              ELSE array_append(message_threads.participant_user_ids, ${senderUserId}::uuid) END,
            updated_at = now()`;
    return { row, created: true };
  }
  await tx.conversation.updateMany({
    where: { id: conversationId, organizationId, OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: createdAt } }] },
    data: { lastMessageAt: createdAt },
  });
  return { row, created: true };
}

/** Guarded update: a delete committed in between must win (the body is already erased). Null when it lost. */
export async function editMessage(
  tx: Tx,
  scope: { organizationId: string; conversationId: string },
  messageId: string,
  body: string,
): Promise<MessageRow | null> {
  const now = new Date();
  const { count } = await tx.message.updateMany({
    where: { id: messageId, ...scope, deletedAt: null },
    data: { body, editedAt: now, updatedAt: now },
  });
  if (count === 0) return null;
  return tx.message.findFirstOrThrow({ where: { id: messageId, ...scope } });
}

/** Erases the body. False when the message was already deleted. */
export async function eraseMessage(
  tx: Tx,
  scope: { organizationId: string; conversationId: string },
  messageId: string,
): Promise<boolean> {
  const now = new Date();
  const { count } = await tx.message.updateMany({
    where: { id: messageId, ...scope, deletedAt: null },
    data: { body: '', deletedAt: now, updatedAt: now },
  });
  if (count === 0) return false;
  // The content is gone, and so is everything that quoted, reacted to or attached to it (and with the attachments,
  // every non-uploader's access to the files).
  const where = { organizationId: scope.organizationId, messageId };
  await tx.messageMention.deleteMany({ where });
  await tx.messageReaction.deleteMany({ where });
  await tx.messageAttachment.deleteMany({ where });
  // A deleted reply no longer counts in its thread (the summary keeps the last reply time and the first repliers).
  const reply = await tx.message.findFirst({ where: { id: messageId, ...scope }, select: { threadRootId: true } });
  if (reply?.threadRootId) {
    await tx.$executeRaw`
      UPDATE messaging.message_threads SET reply_count = GREATEST(reply_count - 1, 0), updated_at = now()
      WHERE root_message_id = ${reply.threadRootId}::uuid AND organization_id = ${scope.organizationId}::uuid`;
  }
  return true;
}

/** True when the reaction is new (an existing one is left alone). */
export async function addReaction(
  tx: Tx,
  actor: { organizationId: string; userId: string },
  messageId: string,
  emoji: string,
): Promise<boolean> {
  const { organizationId, userId } = actor;
  // Serialize adds per message: the cap of distinct emoji is checked and applied under the message row lock, so
  // concurrent first reactions with different emoji cannot all pass the check.
  // A delete committed before the lock leaves no row to lock: the message is gone (its reactions were erased).
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM messaging.messages
    WHERE id = ${messageId}::uuid AND organization_id = ${organizationId}::uuid AND deleted_at IS NULL FOR UPDATE`;
  if (locked.length === 0) throw conflict('message_deleted', 'The message was deleted.');
  const mine = await tx.messageReaction.count({ where: { organizationId, messageId, userId, emoji } });
  if (mine > 0) return false;
  const distinct = await tx.messageReaction.groupBy({ by: ['emoji'], where: { organizationId, messageId } });
  if (distinct.length >= MAX_REACTIONS_PER_MESSAGE && !distinct.some((row) => row.emoji === emoji))
    throw conflict('too_many_reactions', 'The message has too many different reactions.');
  const { count } = await tx.messageReaction.createMany({
    data: [{ organizationId, messageId, userId, emoji }],
    skipDuplicates: true,
  });
  return count > 0;
}

/** True when a reaction was removed. */
export async function removeReaction(
  tx: Tx,
  actor: { organizationId: string; userId: string },
  messageId: string,
  emoji: string,
): Promise<boolean> {
  const { count } = await tx.messageReaction.deleteMany({
    where: { organizationId: actor.organizationId, messageId, userId: actor.userId, emoji },
  });
  return count > 0;
}

export async function setBookmark(
  tx: Tx,
  actor: { organizationId: string; userId: string },
  messageId: string,
  saved: boolean,
): Promise<boolean> {
  const { organizationId, userId } = actor;
  if (!saved) return (await tx.messageBookmark.deleteMany({ where: { organizationId, userId, messageId } })).count > 0;
  // One person's saves are counted under an advisory lock, so concurrent saves cannot pass the cap together.
  await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`bookmarks:${organizationId}:${userId}`}, 0))) l`;
  if ((await tx.messageBookmark.count({ where: { organizationId, userId } })) >= MAX_BOOKMARKS_PER_USER) {
    const already = await tx.messageBookmark.count({ where: { organizationId, userId, messageId } });
    if (already === 0) throw conflict('too_many_bookmarks', 'You have saved too many messages. Remove some first.');
  }
  return (
    (await tx.messageBookmark.createMany({ data: [{ organizationId, userId, messageId }], skipDuplicates: true }))
      .count > 0
  );
}

/** A capped count of top-level messages from others after the caller's read cursor (at most 100 rows are looked at). */
export async function unreadSummary(
  tx: Tx,
  actor: { organizationId: string; userId: string },
  conversationId: string,
  notBefore?: Date,
): Promise<{ unreadCount: number; lastReadMessageId: string | null }> {
  const rows = await tx.$queryRaw<{ last_read_message_id: string | null; unread: number }[]>`
    SELECT rs.last_read_message_id,
           (SELECT count(*)::int FROM (
              SELECT 1 FROM messaging.messages x
              WHERE x.conversation_id = ${conversationId}::uuid AND x.organization_id = ${actor.organizationId}::uuid
                AND x.thread_root_id IS NULL AND x.deleted_at IS NULL
                AND x.created_at >= COALESCE(${notBefore ?? null}::timestamptz, '-infinity'::timestamptz)
                AND x.sender_user_id IS DISTINCT FROM ${actor.userId}::uuid
                AND (rs.last_read_message_id IS NULL
                     OR (x.created_at, x.id) > (rs.last_read_at, rs.last_read_message_id))
              LIMIT 100) capped) AS unread
    FROM (SELECT 1) one
    LEFT JOIN messaging.message_read_states rs
      ON rs.conversation_id = ${conversationId}::uuid AND rs.user_id = ${actor.userId}::uuid`;
  return { unreadCount: rows[0]?.unread ?? 0, lastReadMessageId: rows[0]?.last_read_message_id ?? null };
}
