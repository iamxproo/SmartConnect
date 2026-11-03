// Domain events go into organization.outbox_events in the SAME transaction as the state change (transactional
// outbox). Payloads carry identifiers only. Consumers (workspace, messaging, search) arrive with the event relay.
import { currentRequestId } from '@smartconnect/backend-kit';
import type { Prisma } from '../database/client.js';

export interface OrganizationEvent {
  eventType:
    | 'organization.created'
    | 'organization.member.joined'
    | 'organization.member.removed'
    | 'organization.member.role_changed';
  aggregateType: 'organization' | 'member';
  aggregateId: string;
  organizationId: string;
  payload: Record<string, string | null>;
}

export async function recordEvents(tx: Prisma.TransactionClient, events: OrganizationEvent[]): Promise<void> {
  if (events.length === 0) return;
  const requestId = currentRequestId() ?? null;
  await tx.outboxEvent.createMany({
    data: events.map((event) => ({
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      organizationId: event.organizationId,
      payload: event.payload,
      headers: { requestId },
    })),
  });
}
