import type {
  Channel,
  Conversation,
  ConversationMessage,
  Member,
  Membership,
  Message,
  OrgSummary,
  User,
  Workspace,
} from '@/lib/api/types';
import { json, problem, type Handler } from './api-stub';

export const user = (overrides: Partial<User> = {}): User => ({
  id: 'user-1',
  email: 'ada@example.com',
  emailVerified: true,
  displayName: 'Ada Lovelace',
  ...overrides,
});

export const acme: OrgSummary = {
  id: 'org-1',
  slug: 'acme',
  name: 'Acme Corp',
  role: { key: 'member', name: 'Member' },
};
export const globex: OrgSummary = {
  id: 'org-2',
  slug: 'globex',
  name: 'Globex',
  role: { key: 'admin', name: 'Admin' },
};

export const membership = (permissions: string[], roleName = 'Member'): Membership => ({
  memberId: 'member-1',
  organizationId: 'org-1',
  role: { id: 'role-1', key: roleName.toLowerCase(), name: roleName, permissions },
  title: null,
  joinedAt: '2026-01-01T00:00:00.000Z',
});

export const member = (overrides: Partial<Member> = {}): Member => ({
  id: 'member-1',
  userId: 'user-1',
  displayName: 'Ada Lovelace',
  email: 'ada@example.com',
  role: { id: 'role-1', key: 'member', name: 'Member' },
  title: null,
  status: 'active',
  joinedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

export const workspace = (overrides: Partial<Workspace> = {}): Workspace => ({
  id: 'ws-1',
  organizationId: 'org-1',
  name: 'Engineering',
  slug: 'engineering',
  description: null,
  visibility: 'open',
  myRole: 'member',
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

export const channel = (overrides: Partial<Channel> = {}): Channel => ({
  id: 'ch-1',
  workspaceId: 'ws-1',
  name: 'general',
  topic: null,
  description: null,
  type: 'public',
  isDefault: true,
  isMember: true,
  myRole: 'member',
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

/** A browser with a live session: refresh succeeds and /auth/me answers. */
export const signedIn = (who: User = user()): Record<string, Handler> => ({
  'POST /auth/refresh': () => ({ accessToken: 'access-1', tokenType: 'Bearer', expiresIn: 900 }),
  'GET /auth/me': () => who,
});

/** A browser with no session cookie. */
export const signedOut: Record<string, Handler> = {
  'POST /auth/refresh': () => problem(401, 'invalid_refresh_token'),
};

/** A member of Acme with the given permissions, plus empty org data, so pages can render. */
export const inAcme = (permissions: string[] = []): Record<string, Handler> => ({
  ...signedIn(),
  'GET /orgs': () => ({ data: [acme] }),
  'GET /orgs/org-1': () => ({
    id: 'org-1',
    slug: 'acme',
    name: 'Acme Corp',
    description: 'Makers of everything',
    status: 'active',
    settings: { invitationExpiryDays: 7 },
    createdAt: '2026-01-01T00:00:00.000Z',
  }),
  'GET /orgs/org-1/me': () => membership(permissions),
  'GET /orgs/org-1/workspaces': () => ({ data: [] }),
  'GET /orgs/org-1/activity/unread-count': () => ({ count: 0 }),
  'GET /orgs/org-1/notification-preferences': () => ({ data: [] }),
});

export const page = <T>(data: T[]) => json(200, { data, nextCursor: null });

export const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'msg-1',
  channelId: 'ch-1',
  senderUserId: 'user-1',
  type: 'standard',
  body: 'Hello team',
  clientMessageId: null,
  threadRootId: null,
  createdAt: '2026-11-03T10:00:00.000Z',
  editedAt: null,
  deletedAt: null,
  thread: null,
  reactions: [],
  mentionedUserIds: [],
  bookmarked: false,
  ...overrides,
});

export const conversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: 'conv-1',
  kind: 'direct',
  title: null,
  createdByUserId: 'user-1',
  participants: [
    { userId: 'user-1', role: 'member', joinedAt: '2026-11-01T00:00:00.000Z' },
    { userId: 'user-2', role: 'member', joinedAt: '2026-11-01T00:00:00.000Z' },
  ],
  myRole: 'member',
  createdAt: '2026-11-01T00:00:00.000Z',
  lastMessageAt: null,
  lastActivityAt: '2026-11-01T00:00:00.000Z',
  unreadCount: 0,
  lastReadMessageId: null,
  ...overrides,
});

export const conversationMessage = (overrides: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id: 'cm-1',
  conversationId: 'conv-1',
  senderUserId: 'user-2',
  type: 'standard',
  body: 'Hi Ada',
  clientMessageId: null,
  threadRootId: null,
  createdAt: '2026-11-03T10:00:00.000Z',
  editedAt: null,
  deletedAt: null,
  thread: null,
  reactions: [],
  mentionedUserIds: [],
  bookmarked: false,
  ...overrides,
});
