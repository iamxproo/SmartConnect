import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eventTypeOf, parseFanOutEvent, parseMessageEvent } from '../src/events/message-event.js';

const ids = () => ({
  organizationId: randomUUID(),
  workspaceId: randomUUID(),
  channelId: randomUUID(),
  messageId: randomUUID(),
});

describe('parseMessageEvent', () => {
  it('rebuilds the payload from the validated fields only', () => {
    const e = ids();
    const parsed = parseMessageEvent(
      JSON.stringify({ service: 'messaging', type: 'message.deleted', ...e, body: 'x' }),
    );
    expect(parsed).toEqual({ type: 'deleted', ...e });
  });

  it('normalizes ids to lower case', () => {
    const e = ids();
    const upper = { ...e, channelId: e.channelId.toUpperCase() };
    expect(
      parseMessageEvent(JSON.stringify({ service: 'messaging', type: 'message.created', ...upper }))?.channelId,
    ).toBe(e.channelId);
  });

  it('reports only a sane event type for logging', () => {
    expect(eventTypeOf(JSON.stringify({ type: 'message.created', body: 'secret' }))).toBe('message.created');
    expect(eventTypeOf(JSON.stringify({ type: 'secret body here!' }))).toBe('unknown');
    expect(eventTypeOf('garbage')).toBe('unknown');
  });
});

describe('parseFanOutEvent', () => {
  const conversation = () => ({
    service: 'messaging',
    type: 'conversation.changed',
    change: 'read',
    organizationId: randomUUID(),
    conversationId: randomUUID(),
    messageId: randomUUID(),
    recipientUserIds: [randomUUID()],
  });

  it('routes channel events unchanged', () => {
    const e = ids();
    expect(parseFanOutEvent(JSON.stringify({ service: 'messaging', type: 'message.created', ...e }))).toEqual({
      kind: 'channel',
      event: { type: 'created', ...e },
    });
  });

  it('keeps recipients out of the client payload, lower-cased and de-duplicated', () => {
    const e = conversation();
    const recipient = e.recipientUserIds[0]!;
    const parsed = parseFanOutEvent(
      JSON.stringify({ ...e, recipientUserIds: [recipient.toUpperCase(), recipient], body: 'x', title: 'y' }),
    );
    expect(parsed).toEqual({
      kind: 'conversation',
      event: {
        organizationId: e.organizationId,
        conversationId: e.conversationId,
        change: 'read',
        messageId: e.messageId,
      },
      recipientUserIds: [recipient],
    });
  });

  it('requires a message id exactly for message changes and read, and null for conversation.updated', () => {
    const e = conversation();
    expect(parseFanOutEvent(JSON.stringify({ ...e, change: 'conversation.updated', messageId: null }))).toBeDefined();
    expect(parseFanOutEvent(JSON.stringify({ ...e, change: 'conversation.updated' }))).toBeUndefined();
    expect(parseFanOutEvent(JSON.stringify({ ...e, change: 'message.deleted', messageId: null }))).toBeUndefined();
    expect(parseFanOutEvent(JSON.stringify({ ...e, recipientUserIds: undefined }))).toBeUndefined();
  });

  it('refuses oversized events', () => {
    const e = conversation();
    expect(parseFanOutEvent(JSON.stringify({ ...e, padding: 'x'.repeat(9000) }))).toBeUndefined();
  });
});
