// Message and attachment-name search. Authorization is part of the SQL, never a post-filter, so nothing outside the
// caller's scope is read, ranked or counted:
//   - channel conversations of the channels the workspace service lists for the caller (asked as the caller);
//   - the caller's own direct and group conversations, from their join (created_at >= joined_at);
//   - never deleted messages, and replies only while their root is visible and not deleted.
// A channelId/conversationId filter only narrows that scope, so a filter outside it gives exactly the empty answer of
// a search with no hits. The response carries no totals.
import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { withTenant } from '../database/client.js';
import { PRISMA, type MessagingPrisma } from '../database/prisma.token.js';
import { Prisma } from '../generated/prisma/client.js';
import { decodeCursor, encodeCursor, type TimelinePosition } from '../messages/cursor.js';
import { decorations, messageFields, type MessageRow } from '../messages/message-store.js';
import type { FileSearchDto, MessageSearchDto, SearchLocation, SearchQueryDto } from './dto.js';
import { VisibleChannels } from './visible-channels.js';

interface Actor {
  organizationId: string;
  userId: string;
}

interface Placed {
  kind: 'channel' | 'direct' | 'group';
  workspace_id: string | null;
  channel_id: string | null;
  conversation_id: string;
}

interface MessageHit extends Placed {
  id: string;
  sender_user_id: string | null;
  type: 'standard' | 'system';
  body: string;
  client_message_id: string | null;
  thread_root_id: string | null;
  created_at: Date;
  edited_at: Date | null;
}

interface FileHit extends Placed {
  attachment_id: string;
  file_id: string;
  name: string | null;
  mime_type: string | null;
  size_bytes: bigint | null;
  message_id: string;
  created_at: Date;
}

const { sql, empty, join } = Prisma;

const locationOf = (row: Placed): SearchLocation =>
  row.kind === 'channel'
    ? { kind: 'channel', workspaceId: row.workspace_id!, channelId: row.channel_id! }
    : { kind: row.kind, conversationId: row.conversation_id };

/** `%`, `_` and the escape character itself match literally in an ILIKE pattern. */
export const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

@Injectable()
export class SearchService {
  constructor(
    @Inject(PRISMA) private readonly prisma: MessagingPrisma,
    @Inject(VisibleChannels) private readonly channels: VisibleChannels,
  ) {}

  async run(actor: Actor, query: SearchQueryDto, req: Request): Promise<MessageSearchDto | FileSearchDto> {
    const channelIds = await this.channels.idsFor(actor.organizationId, req);
    const limit = query.limit ?? 20;
    const after = decodeCursor(query.cursor);
    const scope = scopeOf(actor, channelIds, query);
    const filters = filtersOf(query);
    return query.type === 'files'
      ? this.files(actor, scope, filters, query.q, limit, after)
      : this.messages(actor, scope, filters, query.q, limit, after);
  }

  private async messages(
    actor: Actor,
    scope: Prisma.Sql,
    filters: Prisma.Sql,
    q: string,
    limit: number,
    after: TimelinePosition | undefined,
  ): Promise<MessageSearchDto> {
    return withTenant(this.prisma, actor, async (tx) => {
      const rows = await tx.$queryRaw<MessageHit[]>`
        WITH scope AS (${scope})
        SELECT m.id, m.conversation_id, m.sender_user_id, m.type::text AS type, m.body, m.client_message_id,
               m.thread_root_id, m.created_at, m.edited_at, s.kind, s.workspace_id, s.channel_id
        FROM messaging.messages m
        JOIN scope s ON s.id = m.conversation_id
        LEFT JOIN messaging.messages r ON r.organization_id = m.organization_id AND r.id = m.thread_root_id
        WHERE m.organization_id = ${actor.organizationId}::uuid
          AND m.deleted_at IS NULL
          AND (s.since IS NULL OR m.created_at >= s.since)
          AND (m.thread_root_id IS NULL
               OR (r.deleted_at IS NULL AND r.conversation_id = m.conversation_id
                   AND (s.since IS NULL OR r.created_at >= s.since)))
          AND to_tsvector('simple', m.body) @@ websearch_to_tsquery('simple', ${q})
          ${filters}
          ${pageAfter(after)}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${limit + 1}`;
      const page = rows.slice(0, limit);
      const decorated = await decorations(tx, actor, page.map(toMessageRow));
      const data = page.map((row) => ({
        ...messageFields(toMessageRow(row), decorated.get(row.id)),
        location: locationOf(row),
      }));
      return { data, nextCursor: rows.length > limit ? encodeCursor(cursorOf(page[page.length - 1]!)) : null };
    });
  }

  private async files(
    actor: Actor,
    scope: Prisma.Sql,
    filters: Prisma.Sql,
    q: string,
    limit: number,
    after: TimelinePosition | undefined,
  ): Promise<FileSearchDto> {
    const pattern = `%${escapeLike(q)}%`;
    return withTenant(this.prisma, actor, async (tx) => {
      const rows = await tx.$queryRaw<FileHit[]>`
        WITH scope AS (${scope})
        SELECT a.id AS attachment_id, a.file_id, a.name, a.mime_type, a.size_bytes, m.id AS message_id,
               m.created_at, m.conversation_id, s.kind, s.workspace_id, s.channel_id
        FROM messaging.messages m
        JOIN scope s ON s.id = m.conversation_id
        JOIN messaging.message_attachments a ON a.organization_id = m.organization_id AND a.message_id = m.id
        LEFT JOIN messaging.messages r ON r.organization_id = m.organization_id AND r.id = m.thread_root_id
        WHERE m.organization_id = ${actor.organizationId}::uuid
          AND m.deleted_at IS NULL
          AND (s.since IS NULL OR m.created_at >= s.since)
          AND (m.thread_root_id IS NULL
               OR (r.deleted_at IS NULL AND r.conversation_id = m.conversation_id
                   AND (s.since IS NULL OR r.created_at >= s.since)))
          AND a.name ILIKE ${pattern} ESCAPE '\\'
          ${filters}
          ${after ? sql`AND (m.created_at, a.id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)` : empty}
        ORDER BY m.created_at DESC, a.id DESC
        LIMIT ${limit + 1}`;
      const page = rows.slice(0, limit);
      const data = page.map((row) => ({
        fileId: row.file_id,
        name: row.name,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
        messageId: row.message_id,
        location: locationOf(row),
        createdAt: row.created_at.toISOString(),
      }));
      const last = page[page.length - 1];
      return {
        data,
        nextCursor: rows.length > limit ? encodeCursor({ createdAt: last!.created_at, id: last!.attachment_id }) : null,
      };
    });
  }
}

const toMessageRow = (row: MessageHit): MessageRow => ({
  id: row.id,
  senderUserId: row.sender_user_id,
  type: row.type,
  body: row.body,
  clientMessageId: row.client_message_id,
  threadRootId: row.thread_root_id,
  createdAt: row.created_at,
  editedAt: row.edited_at,
  deletedAt: null,
});

const cursorOf = (row: MessageHit): TimelinePosition => ({ createdAt: row.created_at, id: row.id });

const pageAfter = (after: TimelinePosition | undefined): Prisma.Sql =>
  after ? sql`AND (m.created_at, m.id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)` : empty;

/** The conversations the caller may search, narrowed by the optional channel or conversation filter. */
function scopeOf(actor: Actor, channelIds: string[], query: SearchQueryDto): Prisma.Sql {
  const channelOnly = query.channelId ? sql`AND c.channel_id = ${query.channelId}::uuid` : empty;
  const byId = query.conversationId ? sql`AND c.id = ${query.conversationId}::uuid` : empty;
  // A channel filter excludes direct and group conversations.
  const directs = query.channelId ? sql`AND false` : empty;
  return sql`
    SELECT c.id, c.kind::text AS kind, c.workspace_id, c.channel_id, NULL::timestamptz AS since
    FROM messaging.conversations c
    WHERE c.organization_id = ${actor.organizationId}::uuid AND c.kind = 'channel'
      AND c.channel_id = ANY(${channelIds}::uuid[]) ${channelOnly} ${byId}
    UNION ALL
    SELECT c.id, c.kind::text, NULL::uuid, NULL::uuid, cm.joined_at
    FROM messaging.conversation_members cm
    JOIN messaging.conversations c ON c.organization_id = cm.organization_id AND c.id = cm.conversation_id
    WHERE cm.organization_id = ${actor.organizationId}::uuid AND cm.user_id = ${actor.userId}::uuid
      AND c.kind IN ('direct', 'group') ${directs} ${byId}`;
}

function filtersOf(query: SearchQueryDto): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (query.from) parts.push(sql`AND m.sender_user_id = ${query.from}::uuid`);
  if (query.before) parts.push(sql`AND m.created_at < ${new Date(query.before)}::timestamptz`);
  if (query.after) parts.push(sql`AND m.created_at >= ${new Date(query.after)}::timestamptz`);
  if (query.has === 'file')
    parts.push(
      sql`AND EXISTS (SELECT 1 FROM messaging.message_attachments x WHERE x.organization_id = m.organization_id AND x.message_id = m.id)`,
    );
  return parts.length ? join(parts, ' ') : empty;
}
