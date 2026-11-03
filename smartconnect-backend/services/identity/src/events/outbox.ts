// Domain events go into identity.outbox_events in the SAME transaction as the state change (transactional outbox,
// docs/database/architecture.md). Payloads carry identifiers only: no email addresses, no tokens.
import { currentRequestId } from '@smartconnect/backend-kit';
import type { Prisma } from '../database/client.js';

export type IdentityEvent =
  | { eventType: 'identity.user.registered'; aggregateType: 'user'; aggregateId: string; payload: { userId: string } }
  | {
      eventType: 'identity.user.password_changed';
      aggregateType: 'user';
      aggregateId: string;
      payload: { userId: string; method: 'change' | 'reset' };
    }
  | {
      eventType: 'identity.session.revoked';
      aggregateType: 'session';
      aggregateId: string;
      payload: { sessionId: string; userId: string; reason: SessionRevocationReason };
    };

export type SessionRevocationReason =
  | 'logout'
  | 'logout_all'
  | 'revoked_by_user'
  | 'revoked_others'
  | 'refresh_token_reuse'
  | 'password_changed'
  | 'password_reset'
  | 'account_inactive';

export async function recordEvents(tx: Prisma.TransactionClient, events: IdentityEvent[]): Promise<void> {
  if (events.length === 0) return;
  const requestId = currentRequestId() ?? null;
  await tx.outboxEvent.createMany({
    data: events.map((event) => ({
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.payload,
      headers: { requestId },
    })),
  });
}

export const sessionRevoked = (sessionId: string, userId: string, reason: SessionRevocationReason): IdentityEvent => ({
  eventType: 'identity.session.revoked',
  aggregateType: 'session',
  aggregateId: sessionId,
  payload: { sessionId, userId, reason },
});
