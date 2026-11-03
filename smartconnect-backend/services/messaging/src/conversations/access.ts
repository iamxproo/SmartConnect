// Participation helpers shared by the conversation services. A conversation is visible only to its participants
// (conversation_members); everyone else, owners included, gets the same 404 as for a missing id.
import { notFound } from '../common/errors.js';
import type { Prisma } from '../database/client.js';
import type { ConversationEvent } from '../events/outbox.js';
import type { ConversationChanged } from '../events/realtime-publisher.js';
import type { Role } from './dto.js';

export type Tx = Prisma.TransactionClient;

export interface Actor {
  organizationId: string;
  userId: string;
}

export interface Me {
  role: Role;
  joinedAt: Date;
  kind: 'direct' | 'group';
  directKey: string | null;
}

/** The caller's participation in a direct or group conversation, or null. Channel conversations never match. */
export async function participation(tx: Tx, actor: Actor, conversationId: string): Promise<Me | null> {
  const row = await tx.conversationMember.findFirst({
    where: {
      organizationId: actor.organizationId,
      conversationId,
      userId: actor.userId,
      conversation: { kind: { in: ['direct', 'group'] } },
    },
    select: { role: true, joinedAt: true, conversation: { select: { kind: true, directKey: true } } },
  });
  if (!row) return null;
  return {
    role: row.role,
    joinedAt: row.joinedAt,
    kind: row.conversation.kind as 'direct' | 'group',
    directKey: row.conversation.directKey,
  };
}

export async function requireParticipation(tx: Tx, actor: Actor, conversationId: string): Promise<Me> {
  const me = await participation(tx, actor, conversationId);
  if (!me) throw notFound();
  return me;
}

/**
 * Drops participant rows (and read cursors) that predate the person's CURRENT organization membership: rows of someone
 * removed and re-invited whose own first request has not pruned them yet are not a participation. Callers pass the
 * membership starts from the organization service, so adding such a person again starts fresh (history from now).
 */
export async function dropStaleParticipants(
  tx: Tx,
  actor: Actor,
  conversationId: string,
  memberSince: ReadonlyMap<string, Date>,
): Promise<void> {
  const rows = await tx.conversationMember.findMany({
    where: { organizationId: actor.organizationId, conversationId, userId: { in: [...memberSince.keys()] } },
    select: { userId: true, joinedAt: true },
  });
  const stale = rows.filter((row) => row.joinedAt < memberSince.get(row.userId)!).map((row) => row.userId);
  if (stale.length === 0) return;
  const where = { organizationId: actor.organizationId, conversationId, userId: { in: stale } };
  await tx.messageReadState.deleteMany({ where });
  await tx.conversationMember.deleteMany({ where });
}

/** Serializes participant changes: concurrent changes to one conversation run one after the other. */
export async function lockConversation(tx: Tx, actor: Actor, conversationId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM messaging.conversations
    WHERE id = ${conversationId}::uuid AND organization_id = ${actor.organizationId}::uuid FOR UPDATE`;
  if (rows.length === 0) throw notFound();
}

export async function participantIds(tx: Tx, actor: Actor, conversationId: string): Promise<string[]> {
  const rows = await tx.conversationMember.findMany({
    where: { organizationId: actor.organizationId, conversationId },
    select: { userId: true },
  });
  return rows.map((row) => row.userId);
}

/** The other person of a direct conversation, from its key (their row may have been pruned). */
export const otherOfDirect = (directKey: string, userId: string): string =>
  directKey.split(':').find((id) => id !== userId) ?? userId;

export const conversationEvent = (
  eventType: ConversationEvent['eventType'],
  actor: Actor,
  conversationId: string,
  userId?: string,
): ConversationEvent => ({
  eventType,
  organizationId: actor.organizationId,
  conversationId,
  payload: { conversationId, actorUserId: actor.userId, ...(userId && { userId }) },
});

export const changed = (
  change: ConversationChanged['change'],
  actor: Actor,
  conversationId: string,
  messageId: string | null,
  recipientUserIds: string[],
): ConversationChanged => ({
  change,
  organizationId: actor.organizationId,
  conversationId,
  messageId,
  recipientUserIds,
});

/** Moves the user's read cursor to the message, never backwards. True when it moved. */
export async function advanceReadCursor(
  tx: Tx,
  actor: Actor,
  conversationId: string,
  message: { id: string; createdAt: Date },
): Promise<boolean> {
  const moved = await tx.$executeRaw`
    INSERT INTO messaging.message_read_states
      (organization_id, conversation_id, user_id, last_read_message_id, last_read_at, updated_at)
    VALUES (${actor.organizationId}::uuid, ${conversationId}::uuid, ${actor.userId}::uuid,
            ${message.id}::uuid, ${message.createdAt}::timestamptz, now())
    ON CONFLICT (conversation_id, user_id) DO UPDATE
      SET last_read_message_id = EXCLUDED.last_read_message_id,
          last_read_at = EXCLUDED.last_read_at,
          updated_at = now()
      WHERE message_read_states.last_read_message_id IS NULL
         OR (EXCLUDED.last_read_at, EXCLUDED.last_read_message_id)
          > (message_read_states.last_read_at, message_read_states.last_read_message_id)`;
  return moved > 0;
}
