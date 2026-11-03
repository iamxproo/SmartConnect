// Domain events go into messaging.outbox_events in the SAME transaction as the state change (transactional outbox).
// Payloads carry identifiers only: message bodies, titles and names never leave this service through events.
import { currentRequestId } from '@smartconnect/backend-kit';
import type { Prisma } from '../database/client.js';

export interface MessageEvent {
  eventType: 'messaging.message.created' | 'messaging.message.updated' | 'messaging.message.deleted';
  organizationId: string;
  messageId: string;
  /** Channel messages carry their channel and workspace; conversation messages carry neither. */
  payload: { messageId: string; conversationId: string; actorUserId: string; channelId?: string; workspaceId?: string };
}

export interface ConversationEvent {
  eventType:
    | 'messaging.conversation.created'
    | 'messaging.conversation.updated'
    | 'messaging.conversation.participant_added'
    | 'messaging.conversation.participant_removed';
  organizationId: string;
  conversationId: string;
  /** `userId` is the participant added or removed. */
  payload: { conversationId: string; actorUserId: string; userId?: string };
}

export async function recordEvents(
  tx: Prisma.TransactionClient,
  events: (MessageEvent | ConversationEvent)[],
): Promise<void> {
  if (events.length === 0) return;
  const requestId = currentRequestId() ?? null;
  await tx.outboxEvent.createMany({
    data: events.map((event) => ({
      aggregateType: 'messageId' in event ? 'message' : 'conversation',
      aggregateId: 'messageId' in event ? event.messageId : event.conversationId,
      eventType: event.eventType,
      organizationId: event.organizationId,
      payload: event.payload,
      headers: { requestId },
    })),
  });
}
