// Who may read an attached file besides its uploader: whoever can see a non-deleted message that attaches it. The
// files service asks this as the caller. Visibility is decided exactly as for reading the message: channels by the
// caller's visible-channels list (the workspace service, asked once as the caller), conversations by participation
// and history from join; a reply also needs a readable root. One query decides; no admin bypass.
import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { notFound } from '../common/errors.js';
import { withTenant } from '../database/client.js';
import { PRISMA, type MessagingPrisma } from '../database/prisma.token.js';
import { VisibleChannels } from '../search/visible-channels.js';

@Injectable()
export class AttachmentsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: MessagingPrisma,
    @Inject(VisibleChannels) private readonly channels: VisibleChannels,
  ) {}

  /** Resolves when the caller can see an attaching message; 404 otherwise, 503 when the workspace service fails. */
  async requireVisible(actor: { organizationId: string; userId: string }, fileId: string, req: Request): Promise<void> {
    const { organizationId, userId } = actor;
    const channelIds = await this.channels.idsFor(organizationId, req);
    const rows = await withTenant(
      this.prisma,
      actor,
      (tx) => tx.$queryRaw<{ found: number }[]>`
        SELECT 1 AS found
        FROM messaging.message_attachments a
        JOIN messaging.messages m ON m.organization_id = a.organization_id AND m.id = a.message_id
        JOIN messaging.conversations c ON c.organization_id = m.organization_id AND c.id = m.conversation_id
        LEFT JOIN messaging.messages root ON root.organization_id = m.organization_id AND root.id = m.thread_root_id
        LEFT JOIN messaging.conversation_members cm
          ON cm.conversation_id = c.id AND cm.user_id = ${userId}::uuid AND c.kind <> 'channel'
        WHERE a.organization_id = ${organizationId}::uuid AND a.file_id = ${fileId}::uuid
          AND m.deleted_at IS NULL
          AND (m.thread_root_id IS NULL OR (root.id IS NOT NULL AND root.deleted_at IS NULL))
          AND ((c.kind = 'channel' AND c.channel_id = ANY(${channelIds}::uuid[]))
            OR (c.kind <> 'channel' AND cm.user_id IS NOT NULL AND m.created_at >= cm.joined_at
                AND (root.id IS NULL OR root.created_at >= cm.joined_at)))
        LIMIT 1`,
    );
    if (rows.length === 0) throw notFound();
  }
}
