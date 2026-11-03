// The caller's activity: mentions of them, and replies in threads they take part in. It is a read model over the
// messages themselves, so visibility is decided again on every read: channel items only for channels in the caller's
// visible-channels list, conversation items only with participation and from the join onward, never deleted messages
// or the caller's own, and the caller's notification level for the conversation applies.
import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { withTenant } from '../database/client.js';
import { PRISMA, type MessagingPrisma } from '../database/prisma.token.js';
import { Prisma } from '../generated/prisma/client.js';
import { decodeCursor, encodeCursor } from '../messages/cursor.js';
import type { ActivityFilter, ActivityItemDto, ActivityListDto } from './dto.js';
import { excerptOf } from './excerpt.js';
import { VisibleChannels } from '../search/visible-channels.js';

interface Actor {
  organizationId: string;
  userId: string;
}

export type ActivityKindName = 'mention' | 'thread_reply';

interface ItemRow {
  kind: ActivityKindName;
  id: string;
  created_at: Date;
  sender_user_id: string | null;
  thread_root_id: string | null;
  body: string;
  conversation_id: string;
  conversation_kind: 'channel' | 'direct' | 'group';
  workspace_id: string | null;
  channel_id: string | null;
  unread: boolean;
}

export const UNREAD_CAP = 100;

/** The items the caller may see, with their unread flag. `kinds` narrows which kinds are built at all. */
function itemsQuery(actor: Actor, channelIds: string[], kinds: ActivityKindName[]): Prisma.Sql {
  const { organizationId: org, userId: me } = actor;
  const common = (msg: string) => Prisma.sql`
    JOIN messaging.conversations c
      ON c.organization_id = ${Prisma.raw(msg)}.organization_id AND c.id = ${Prisma.raw(msg)}.conversation_id
    LEFT JOIN messaging.conversation_members cm
      ON cm.conversation_id = c.id AND cm.user_id = ${me}::uuid AND c.kind <> 'channel'
    LEFT JOIN messaging.conversation_preferences cp ON cp.conversation_id = c.id AND cp.user_id = ${me}::uuid`;
  const visible = (msg: string) => Prisma.sql`
    AND ((c.kind = 'channel' AND c.channel_id = ANY(${channelIds}::uuid[]))
      OR (c.kind <> 'channel' AND cm.user_id IS NOT NULL AND ${Prisma.raw(msg)}.created_at >= cm.joined_at))`;
  const columns = (kind: ActivityKindName, msg: string) => Prisma.sql`
    SELECT ${kind}::text AS kind, ${Prisma.raw(msg)}.id, ${Prisma.raw(msg)}.created_at,
           ${Prisma.raw(msg)}.sender_user_id, ${Prisma.raw(msg)}.thread_root_id, ${Prisma.raw(msg)}.body,
           ${Prisma.raw(msg)}.conversation_id, c.kind::text AS conversation_kind, c.workspace_id, c.channel_id,
           (${Prisma.raw(msg)}.created_at > COALESCE((SELECT seen_until FROM messaging.activity_read_states
                                          WHERE organization_id = ${org}::uuid AND user_id = ${me}::uuid),
                                         '-infinity'::timestamptz)
            AND NOT EXISTS (SELECT 1 FROM messaging.activity_item_reads air
                            WHERE air.user_id = ${me}::uuid AND air.message_id = ${Prisma.raw(msg)}.id
                              AND air.kind = ${kind}::messaging."ActivityKind")) AS unread`;

  const branches: Prisma.Sql[] = [];
  if (kinds.includes('mention'))
    branches.push(Prisma.sql`
      ${columns('mention', 'm')}
      FROM messaging.message_mentions mm
      JOIN messaging.messages m ON m.organization_id = mm.organization_id AND m.id = mm.message_id
      LEFT JOIN messaging.messages mroot ON mroot.organization_id = m.organization_id AND mroot.id = m.thread_root_id
      ${common('m')}
      WHERE mm.organization_id = ${org}::uuid AND mm.mentioned_user_id = ${me}::uuid AND mm.kind = 'user'
        AND m.deleted_at IS NULL AND m.sender_user_id <> ${me}::uuid
        AND COALESCE(cp.level::text, 'all') <> 'none'
        AND (m.thread_root_id IS NULL
          OR (mroot.deleted_at IS NULL AND (c.kind = 'channel' OR mroot.created_at >= cm.joined_at)))
        ${visible('m')}`);
  if (kinds.includes('thread_reply'))
    branches.push(Prisma.sql`
      ${columns('thread_reply', 'r')}
      FROM messaging.messages r
      JOIN messaging.messages root ON root.organization_id = r.organization_id AND root.id = r.thread_root_id
      LEFT JOIN messaging.message_threads t ON t.organization_id = root.organization_id AND t.root_message_id = root.id
      ${common('r')}
      WHERE r.organization_id = ${org}::uuid AND r.thread_root_id IS NOT NULL
        AND r.deleted_at IS NULL AND r.sender_user_id <> ${me}::uuid
        AND COALESCE(cp.level::text, 'all') = 'all'
        AND root.deleted_at IS NULL AND (c.kind = 'channel' OR root.created_at >= cm.joined_at)
        AND NOT EXISTS (SELECT 1 FROM messaging.message_mentions own
                        WHERE own.organization_id = r.organization_id AND own.message_id = r.id
                          AND own.kind = 'user' AND own.mentioned_user_id = ${me}::uuid)
        AND (root.sender_user_id = ${me}::uuid
          OR ${me}::uuid = ANY(COALESCE(t.participant_user_ids, ARRAY[]::uuid[]))
          OR EXISTS (SELECT 1 FROM messaging.messages mine
                     WHERE mine.organization_id = root.organization_id AND mine.thread_root_id = root.id
                       AND mine.sender_user_id = ${me}::uuid AND mine.deleted_at IS NULL)
          OR EXISTS (SELECT 1 FROM messaging.message_mentions tm
                     JOIN messaging.messages tmm ON tmm.organization_id = tm.organization_id AND tmm.id = tm.message_id
                     WHERE tm.organization_id = root.organization_id AND tm.kind = 'user'
                       AND tm.mentioned_user_id = ${me}::uuid AND tmm.deleted_at IS NULL
                       AND (tmm.id = root.id OR tmm.thread_root_id = root.id)))
        ${visible('r')}`);
  return Prisma.join(
    branches.map((b) => Prisma.sql`(${b})`),
    ' UNION ALL ',
  );
}

const kindsOf = (filter: ActivityFilter): ActivityKindName[] =>
  filter === 'mentions' ? ['mention'] : filter === 'threads' ? ['thread_reply'] : ['mention', 'thread_reply'];

@Injectable()
export class ActivityService {
  constructor(
    @Inject(PRISMA) private readonly prisma: MessagingPrisma,
    @Inject(VisibleChannels) private readonly channels: VisibleChannels,
  ) {}

  async list(
    actor: Actor,
    filter: ActivityFilter,
    limit: number,
    cursor: string | undefined,
    req: Request,
  ): Promise<ActivityListDto> {
    const after = decodeCursor(cursor);
    const channelIds = await this.channels.idsFor(actor.organizationId, req);
    const rows = await withTenant(
      this.prisma,
      actor,
      (tx) =>
        tx.$queryRaw<ItemRow[]>`
        SELECT * FROM (${itemsQuery(actor, channelIds, kindsOf(filter))}) items
        WHERE ${filter === 'unread' ? Prisma.sql`unread` : Prisma.sql`TRUE`}
          ${after ? Prisma.sql`AND (created_at, id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)` : Prisma.empty}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit + 1}`,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      data: page.map(toItem),
      nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
    };
  }

  /** Unread items, counting no further than UNREAD_CAP. */
  async unreadCount(actor: Actor, req: Request): Promise<number> {
    const channelIds = await this.channels.idsFor(actor.organizationId, req);
    const rows = await withTenant(
      this.prisma,
      actor,
      (tx) =>
        tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM (
          SELECT 1 FROM (${itemsQuery(actor, channelIds, ['mention', 'thread_reply'])}) items
          WHERE unread LIMIT ${UNREAD_CAP}) capped`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** Marks the given items read, but only those that are really the caller's visible activity; the rest is ignored. */
  async markRead(actor: Actor, itemIds: string[], req: Request): Promise<void> {
    const wanted = new Map<string, Set<ActivityKindName>>();
    for (const itemId of itemIds) {
      const [kind, messageId] = itemId.split(':') as [ActivityKindName, string];
      const kinds = wanted.get(messageId.toLowerCase()) ?? new Set();
      kinds.add(kind);
      wanted.set(messageId.toLowerCase(), kinds);
    }
    const channelIds = await this.channels.idsFor(actor.organizationId, req);
    await withTenant(this.prisma, actor, async (tx) => {
      const rows = await tx.$queryRaw<{ kind: ActivityKindName; id: string }[]>`
        SELECT kind, id FROM (${itemsQuery(actor, channelIds, ['mention', 'thread_reply'])}) items
        WHERE id = ANY(${[...wanted.keys()]}::uuid[])`;
      const own = rows.filter((row) => wanted.get(row.id)?.has(row.kind));
      if (own.length === 0) return;
      await tx.activityItemRead.createMany({
        data: own.map((row) => ({
          organizationId: actor.organizationId,
          userId: actor.userId,
          messageId: row.id,
          kind: row.kind,
        })),
        skipDuplicates: true,
      });
    });
  }

  /** Everything up to now counts as read; the individual reads it covers are dropped. */
  async markAllRead(actor: Actor): Promise<void> {
    await withTenant(this.prisma, actor, async (tx) => {
      await tx.$executeRaw`
        INSERT INTO messaging.activity_read_states (organization_id, user_id, seen_until, updated_at)
        VALUES (${actor.organizationId}::uuid, ${actor.userId}::uuid, now(), now())
        ON CONFLICT (organization_id, user_id) DO UPDATE SET seen_until = now(), updated_at = now()`;
      await tx.activityItemRead.deleteMany({
        where: { organizationId: actor.organizationId, userId: actor.userId },
      });
    });
  }
}

function toItem(row: ItemRow): ActivityItemDto {
  return {
    id: `${row.kind}:${row.id}`,
    kind: row.kind,
    message: {
      id: row.id,
      senderUserId: row.sender_user_id,
      excerpt: excerptOf(row.body),
      createdAt: row.created_at.toISOString(),
      threadRootId: row.thread_root_id,
    },
    location:
      row.conversation_kind === 'channel'
        ? { kind: 'channel', workspaceId: row.workspace_id!, channelId: row.channel_id! }
        : { kind: row.conversation_kind, conversationId: row.conversation_id },
    unread: row.unread,
  };
}
