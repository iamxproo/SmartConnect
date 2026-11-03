// The fan-out events services publish (docs/architecture/realtime.md) and the payloads clients get: `message.changed`
// for channel rooms, `conversation.changed` for conversation inboxes (ADR 0011). Parsing is strict: anything that does
// not match exactly is dropped, and the output is rebuilt from the validated fields only, so nothing else in a
// published message (a body, a title, the recipient list) can ever reach a socket.
export interface MessageChanged {
  type: 'created' | 'updated' | 'deleted';
  organizationId: string;
  workspaceId: string;
  channelId: string;
  messageId: string;
}

export type ConversationChange =
  'message.created' | 'message.updated' | 'message.deleted' | 'conversation.updated' | 'read';

export interface ConversationChanged {
  organizationId: string;
  conversationId: string;
  change: ConversationChange;
  /** The message for message changes and `read` (the new cursor); null for `conversation.updated`. */
  messageId: string | null;
}

/** A conversation event and the users messaging computed as its recipients (never sent to clients). */
export interface ConversationEvent {
  event: ConversationChanged;
  recipientUserIds: string[];
}

export type FanOutEvent = { kind: 'channel'; event: MessageChanged } | ({ kind: 'conversation' } & ConversationEvent);

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Room for 100 recipients plus the ids. */
const MAX_EVENT_BYTES = 8192;
export const MAX_RECIPIENTS = 100;
const TYPES = { 'message.created': 'created', 'message.updated': 'updated', 'message.deleted': 'deleted' } as const;
const CHANGES = new Set<string>([
  'message.created',
  'message.updated',
  'message.deleted',
  'conversation.updated',
  'read',
]);

const isUuid = (id: unknown): id is string => typeof id === 'string' && UUID.test(id);

function parseObject(raw: string): Record<string, unknown> | undefined {
  if (raw.length > MAX_EVENT_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function parseFanOutEvent(raw: string): FanOutEvent | undefined {
  const e = parseObject(raw);
  if (e?.type === 'conversation.changed') {
    const parsed = conversationEventOf(e);
    return parsed && { kind: 'conversation', ...parsed };
  }
  const event = e && messageEventOf(e);
  return event && { kind: 'channel', event };
}

export function parseMessageEvent(raw: string): MessageChanged | undefined {
  const e = parseObject(raw);
  return e && messageEventOf(e);
}

function conversationEventOf(e: Record<string, unknown>): ConversationEvent | undefined {
  if (e.service !== 'messaging' || typeof e.change !== 'string' || !CHANGES.has(e.change)) return undefined;
  if (!isUuid(e.organizationId) || !isUuid(e.conversationId)) return undefined;
  // A message id exactly where the change is about a message (or a read cursor), and nowhere else.
  const needsMessage = e.change !== 'conversation.updated';
  if (needsMessage ? !isUuid(e.messageId) : e.messageId !== null) return undefined;
  const recipients = e.recipientUserIds;
  if (!Array.isArray(recipients) || recipients.length === 0 || recipients.length > MAX_RECIPIENTS) return undefined;
  if (!recipients.every(isUuid)) return undefined;
  return {
    event: {
      organizationId: e.organizationId.toLowerCase(),
      conversationId: e.conversationId.toLowerCase(),
      change: e.change as ConversationChange,
      messageId: needsMessage ? (e.messageId as string).toLowerCase() : null,
    },
    recipientUserIds: [...new Set(recipients.map((id) => id.toLowerCase()))],
  };
}

function messageEventOf(e: Record<string, unknown>): MessageChanged | undefined {
  if (e.service !== 'messaging' || typeof e.type !== 'string' || !Object.hasOwn(TYPES, e.type)) return undefined;
  const ids = [e.organizationId, e.workspaceId, e.channelId, e.messageId];
  if (!ids.every((id): id is string => typeof id === 'string' && UUID.test(id))) return undefined;
  const [organizationId, workspaceId, channelId, messageId] = ids.map((id) => id.toLowerCase()) as [
    string,
    string,
    string,
    string,
  ];
  return { type: TYPES[e.type as keyof typeof TYPES], organizationId, workspaceId, channelId, messageId };
}

/** The type of a raw message for logging when it is malformed: never the content. */
export function eventTypeOf(raw: string): string {
  try {
    const type = (JSON.parse(raw) as { type?: unknown } | null)?.type;
    return typeof type === 'string' && /^[a-z.]{1,40}$/.test(type) ? type : 'unknown';
  } catch {
    return 'unknown';
  }
}
