// Direct and group conversations (ADR 0011). Authorization: the guard established organization membership; here a
// conversation exists for a caller only if they participate (conversation_members), otherwise it is a 404. Participant
// changes run under a row lock on the conversation, so concurrent changes serialize and the checks below hold.
import { Inject, Injectable } from '@nestjs/common';
import { ApiProblemException } from '@smartconnect/backend-kit';
import type { Request } from 'express';
import { OrganizationDirectory } from '../access/organization-directory.js';
import { conflict, forbidden, notFound } from '../common/errors.js';
import { uuidv7 } from '../common/uuid.js';
import { withTenant } from '../database/client.js';
import { PRISMA, type MessagingPrisma } from '../database/prisma.token.js';
import { recordEvents } from '../events/outbox.js';
import { RealtimePublisher, type ConversationChanged } from '../events/realtime-publisher.js';
import { encodeCursor, decodeCursor } from '../messages/cursor.js';
import {
  advanceReadCursor,
  changed,
  conversationEvent,
  dropStaleParticipants,
  lockConversation,
  participantIds,
  requireParticipation,
  type Actor,
  type Tx,
} from './access.js';
import {
  MAX_PARTICIPANTS,
  type ConversationDto,
  type ConversationListDto,
  type ParticipantDto,
  type Role,
} from './dto.js';

interface ConversationRow {
  id: string;
  kind: 'direct' | 'group';
  title: string | null;
  created_by_user_id: string | null;
  created_at: Date;
  last_message_at: Date | null;
  last_activity_at: Date;
  role: Role;
  last_read_message_id: string | null;
  unread: number;
}

const unprocessable = (code: string, detail: string) => new ApiProblemException(422, code, detail);
const notInOrganization = () =>
  unprocessable('user_not_in_organization', 'A user is not an active member of the organization.');

/** Runs `fn` in a tenant transaction, then publishes what it asked to announce, after the commit. */
type Announced<T> = { value: T; announce: ConversationChanged[] };

@Injectable()
export class ConversationsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: MessagingPrisma,
    @Inject(OrganizationDirectory) private readonly organizations: OrganizationDirectory,
    @Inject(RealtimePublisher) private readonly realtime: RealtimePublisher,
  ) {}

  private async commit<T>(actor: Actor, fn: (tx: Tx) => Promise<Announced<T>>): Promise<T> {
    const { value, announce } = await withTenant(this.prisma, actor, fn);
    for (const event of announce) this.realtime.publishConversationChanged(event);
    return value;
  }

  list(actor: Actor, limit: number, cursor: string | undefined): Promise<ConversationListDto> {
    const after = decodeCursor(cursor);
    return withTenant(this.prisma, actor, async (tx) => {
      const rows = await selectConversations(tx, actor, { after, limit: limit + 1 });
      const page = rows.slice(0, limit);
      const data = await withParticipants(tx, actor, page);
      const last = page[page.length - 1];
      return {
        data,
        nextCursor:
          rows.length > limit && last ? encodeCursor({ createdAt: last.last_activity_at, id: last.id }) : null,
      };
    });
  }

  get(actor: Actor, conversationId: string): Promise<ConversationDto> {
    return withTenant(this.prisma, actor, (tx) => viewOf(tx, actor, conversationId));
  }

  /** Find-or-create the one direct conversation of this pair. `created` is false when it already existed. */
  async openDirect(
    actor: Actor,
    otherUserId: string,
    req: Request,
  ): Promise<{ conversation: ConversationDto; created: boolean }> {
    if (otherUserId === actor.userId) throw unprocessable('cannot_message_self', 'You cannot message yourself.');
    const other = await this.organizations.activeMembers(actor.organizationId, [otherUserId], req);
    if (!other.has(otherUserId)) throw notInOrganization();
    const pair = [actor.userId, otherUserId];
    const directKey = [...pair].sort().join(':');
    return this.commit(actor, async (tx) => {
      const now = new Date();
      const where = { organizationId: actor.organizationId, directKey };
      let created = false;
      if (!(await tx.conversation.findFirst({ where, select: { id: true } }))) {
        // A concurrent create of the same pair makes this insert wait, then skip; the re-read finds the winner's row.
        const { count } = await tx.conversation.createMany({
          data: [
            {
              id: uuidv7(now.getTime()),
              organizationId: actor.organizationId,
              kind: 'direct',
              directKey,
              createdByUserId: actor.userId,
              createdAt: now,
            },
          ],
          skipDuplicates: true,
        });
        created = count === 1;
      }
      const { id: conversationId } = await tx.conversation.findFirstOrThrow({ where, select: { id: true } });
      // A pruned (removed and re-invited) participant is re-added and sees only messages from now on. The caller's own
      // leftovers were pruned by the guard; the other person's are dropped here.
      await dropStaleParticipants(tx, actor, conversationId, other);
      const present = new Set(await participantIds(tx, actor, conversationId));
      const missing = pair.filter((id) => !present.has(id));
      const { count: added } = await tx.conversationMember.createMany({
        data: missing.map((userId) => ({
          organizationId: actor.organizationId,
          conversationId,
          userId,
          joinedAt: now,
        })),
        skipDuplicates: true,
      });
      const events = created
        ? [conversationEvent('messaging.conversation.created', actor, conversationId)]
        : added > 0
          ? missing.map((id) =>
              conversationEvent('messaging.conversation.participant_added', actor, conversationId, id),
            )
          : [];
      await recordEvents(tx, events);
      return {
        value: { conversation: await viewOf(tx, actor, conversationId), created },
        announce: events.length ? [changed('conversation.updated', actor, conversationId, null, pair)] : [],
      };
    });
  }

  async createGroup(
    actor: Actor,
    input: { title?: string | null; userIds: string[] },
    req: Request,
  ): Promise<ConversationDto> {
    if (input.userIds.includes(actor.userId))
      throw new ApiProblemException(422, 'validation_failed', '1 validation error', [
        { field: 'userIds', code: 'cannot_include_self', message: 'userIds must list others, not yourself' },
      ]);
    const active = await this.organizations.activeMembers(actor.organizationId, input.userIds, req);
    if (!input.userIds.every((id) => active.has(id))) throw notInOrganization();
    return this.commit(actor, async (tx) => {
      const now = new Date();
      const conversationId = uuidv7(now.getTime());
      await tx.conversation.createMany({
        data: [
          {
            id: conversationId,
            organizationId: actor.organizationId,
            kind: 'group',
            title: input.title ?? null,
            createdByUserId: actor.userId,
            createdAt: now,
          },
        ],
      });
      await tx.conversationMember.createMany({
        data: [actor.userId, ...input.userIds].map((userId) => ({
          organizationId: actor.organizationId,
          conversationId,
          userId,
          role: userId === actor.userId ? ('admin' as const) : ('member' as const),
          joinedAt: now,
        })),
      });
      await recordEvents(tx, [conversationEvent('messaging.conversation.created', actor, conversationId)]);
      return {
        value: await viewOf(tx, actor, conversationId),
        announce: [changed('conversation.updated', actor, conversationId, null, [actor.userId, ...input.userIds])],
      };
    });
  }

  rename(actor: Actor, conversationId: string, title: string | null): Promise<ConversationDto> {
    return this.commit(actor, async (tx) => {
      await this.lockedAdmin(tx, actor, conversationId);
      await tx.conversation.updateMany({
        where: { id: conversationId, organizationId: actor.organizationId },
        data: { title, updatedAt: new Date() },
      });
      await recordEvents(tx, [conversationEvent('messaging.conversation.updated', actor, conversationId)]);
      return {
        value: await viewOf(tx, actor, conversationId),
        announce: [
          changed('conversation.updated', actor, conversationId, null, await participantIds(tx, actor, conversationId)),
        ],
      };
    });
  }

  /** Adds a participant (201) or changes their role (200; also 200 when nothing changes). */
  async putParticipant(
    actor: Actor,
    conversationId: string,
    userId: string,
    role: Role | undefined,
    req: Request,
  ): Promise<{ participant: ParticipantDto; created: boolean }> {
    const active = await this.organizations.activeMembers(actor.organizationId, [userId], req);
    return this.commit<{ participant: ParticipantDto; created: boolean }>(actor, async (tx) => {
      await this.lockedAdmin(tx, actor, conversationId);
      // A row from the person's earlier organization membership is not a participation: adding them starts fresh.
      await dropStaleParticipants(tx, actor, conversationId, active);
      const where = { organizationId: actor.organizationId, conversationId, userId };
      const target = await tx.conversationMember.findFirst({ where });
      if (target) {
        if (role === undefined || role === target.role)
          return { value: { participant: toParticipant(target), created: false }, announce: [] };
        if (role === 'member' && (await adminCount(tx, actor, conversationId)) <= 1)
          throw conflict('last_admin', 'A group needs at least one admin.');
        const updated = await tx.conversationMember.update({ where: { id: target.id }, data: { role } });
        await recordEvents(tx, [conversationEvent('messaging.conversation.updated', actor, conversationId)]);
        return {
          value: { participant: toParticipant(updated), created: false },
          announce: [
            changed(
              'conversation.updated',
              actor,
              conversationId,
              null,
              await participantIds(tx, actor, conversationId),
            ),
          ],
        };
      }
      if (!active.has(userId)) throw notInOrganization();
      if (
        (await tx.conversationMember.count({ where: { organizationId: actor.organizationId, conversationId } })) >=
        MAX_PARTICIPANTS
      )
        throw conflict('conversation_full', `A group has at most ${MAX_PARTICIPANTS} participants.`);
      const added = await tx.conversationMember.create({
        data: { ...where, role: role ?? 'member', joinedAt: new Date() },
      });
      await recordEvents(tx, [
        conversationEvent('messaging.conversation.participant_added', actor, conversationId, userId),
      ]);
      return {
        value: { participant: toParticipant(added), created: true },
        announce: [
          changed('conversation.updated', actor, conversationId, null, await participantIds(tx, actor, conversationId)),
        ],
      };
    });
  }

  /** An admin removes anyone; anyone removes themselves (leave). The longest-standing member replaces a last admin. */
  removeParticipant(actor: Actor, conversationId: string, userId: string): Promise<void> {
    return this.commit(actor, async (tx) => {
      await lockConversation(tx, actor, conversationId);
      const me = await requireParticipation(tx, actor, conversationId);
      if (me.kind !== 'group') throw conflict('not_a_group', 'Participants of a direct conversation cannot change.');
      if (userId !== actor.userId && me.role !== 'admin')
        throw forbidden('forbidden', 'Only a group admin can remove participants.');
      const where = { organizationId: actor.organizationId, conversationId };
      const target = await tx.conversationMember.findFirst({ where: { ...where, userId } });
      if (!target) throw notFound();
      await tx.conversationMember.delete({ where: { id: target.id } });
      await tx.messageReadState.deleteMany({ where: { ...where, userId } });
      if (target.role === 'admin' && (await adminCount(tx, actor, conversationId)) === 0) {
        const successor = await tx.conversationMember.findFirst({
          where,
          orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
        });
        if (successor) await tx.conversationMember.update({ where: { id: successor.id }, data: { role: 'admin' } });
      }
      await recordEvents(tx, [
        conversationEvent('messaging.conversation.participant_removed', actor, conversationId, userId),
      ]);
      const remaining = await participantIds(tx, actor, conversationId);
      return {
        value: undefined,
        announce: [changed('conversation.updated', actor, conversationId, null, [...remaining, userId])],
      };
    });
  }

  /** The read cursor only moves forward. The message must be one the caller can see (from their join onward). */
  markRead(actor: Actor, conversationId: string, messageId: string): Promise<void> {
    return this.commit(actor, async (tx) => {
      const me = await requireParticipation(tx, actor, conversationId);
      const message = await tx.message.findFirst({
        where: {
          id: messageId,
          organizationId: actor.organizationId,
          conversationId,
          threadRootId: null,
          createdAt: { gte: me.joinedAt },
        },
        select: { id: true, createdAt: true },
      });
      if (!message) throw notFound();
      const moved = await advanceReadCursor(tx, actor, conversationId, message);
      return {
        value: undefined,
        announce: moved ? [changed('read', actor, conversationId, message.id, [actor.userId])] : [],
      };
    });
  }

  /** Under the conversation lock: the caller participates (404), it is a group (409) and they are an admin (403). */
  private async lockedAdmin(tx: Tx, actor: Actor, conversationId: string): Promise<void> {
    await lockConversation(tx, actor, conversationId);
    const me = await requireParticipation(tx, actor, conversationId);
    if (me.kind !== 'group')
      throw conflict('not_a_group', 'Participants and title of a direct conversation cannot change.');
    if (me.role !== 'admin') throw forbidden('forbidden', 'Only a group admin can do this.');
  }
}

const adminCount = (tx: Tx, actor: Actor, conversationId: string) =>
  tx.conversationMember.count({ where: { organizationId: actor.organizationId, conversationId, role: 'admin' } });

const toParticipant = (row: { userId: string; role: Role; joinedAt: Date }): ParticipantDto => ({
  userId: row.userId,
  role: row.role,
  joinedAt: row.joinedAt.toISOString(),
});

/**
 * One statement for a page of the caller's conversations. `unread` is a capped count (at most 100 rows are looked at
 * per conversation): messages from others, not deleted, from the caller's join onward and after the read cursor.
 */
async function selectConversations(
  tx: Tx,
  actor: Actor,
  { conversationId, after, limit }: { conversationId?: string; after?: { createdAt: Date; id: string }; limit: number },
): Promise<ConversationRow[]> {
  const cursorTime = after?.createdAt ?? null;
  const cursorId = after?.id ?? null;
  return tx.$queryRaw<ConversationRow[]>`
    SELECT c.id, c.kind::text AS kind, c.title, c.created_by_user_id, c.created_at, c.last_message_at,
           COALESCE(c.last_message_at, c.created_at) AS last_activity_at,
           m.role::text AS role, rs.last_read_message_id,
           (SELECT count(*)::int FROM (
              SELECT 1 FROM messaging.messages x
              WHERE x.conversation_id = c.id AND x.organization_id = c.organization_id
                AND x.thread_root_id IS NULL AND x.deleted_at IS NULL
                AND x.created_at >= m.joined_at
                AND x.sender_user_id IS DISTINCT FROM m.user_id
                AND (rs.last_read_message_id IS NULL
                     OR (x.created_at, x.id) > (rs.last_read_at, rs.last_read_message_id))
              LIMIT 100) capped) AS unread
    FROM messaging.conversation_members m
    JOIN messaging.conversations c ON c.id = m.conversation_id AND c.organization_id = m.organization_id
    LEFT JOIN messaging.message_read_states rs ON rs.conversation_id = c.id AND rs.user_id = m.user_id
    WHERE m.organization_id = ${actor.organizationId}::uuid AND m.user_id = ${actor.userId}::uuid
      AND c.kind IN ('direct', 'group')
      AND (${conversationId ?? null}::uuid IS NULL OR c.id = ${conversationId ?? null}::uuid)
      AND (${cursorTime}::timestamptz IS NULL
           OR (COALESCE(c.last_message_at, c.created_at), c.id) < (${cursorTime}::timestamptz, ${cursorId}::uuid))
    ORDER BY last_activity_at DESC, c.id DESC
    LIMIT ${limit}`;
}

async function withParticipants(tx: Tx, actor: Actor, rows: ConversationRow[]): Promise<ConversationDto[]> {
  const members = await tx.conversationMember.findMany({
    where: { organizationId: actor.organizationId, conversationId: { in: rows.map((row) => row.id) } },
    orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
  });
  const byConversation = new Map<string, ParticipantDto[]>();
  for (const member of members) {
    const list = byConversation.get(member.conversationId) ?? [];
    list.push(toParticipant(member));
    byConversation.set(member.conversationId, list);
  }
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    createdByUserId: row.created_by_user_id,
    participants: byConversation.get(row.id) ?? [],
    myRole: row.role,
    createdAt: row.created_at.toISOString(),
    lastMessageAt: row.last_message_at?.toISOString() ?? null,
    lastActivityAt: row.last_activity_at.toISOString(),
    unreadCount: row.unread,
    lastReadMessageId: row.last_read_message_id,
  }));
}

/** The conversation as the caller sees it; 404 when they do not participate. */
export async function viewOf(tx: Tx, actor: Actor, conversationId: string): Promise<ConversationDto> {
  const rows = await selectConversations(tx, actor, { conversationId, limit: 1 });
  if (rows.length === 0) throw notFound();
  return (await withParticipants(tx, actor, rows))[0]!;
}
