// Response shapes of docs/api/endpoints.md. Only fields the contract defines.

export interface Page<T> {
  data: T[];
  nextCursor?: string | null;
}

export interface TokenResponse {
  accessToken: string;
  expiresIn: number;
}

export interface User {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  /** Platform-wide roles (ADR 0015), e.g. `super_admin`; empty for almost everyone. Organization roles are separate. */
  platformRoles?: string[];
  /** The password was issued (development Super Admin) and must be replaced before platform administration. */
  passwordChangeRequired?: boolean;
}

/** GET /admin/accounts/summary (Super Admin only). */
export interface AdminAccountSummary {
  total: number;
  verified: number;
  active: number;
  suspended: number;
  deactivated: number;
  superAdmins: number;
}

/** GET /admin/organizations (Super Admin only): directory fields only, never organization content. */
export interface AdminOrganization {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  memberCount: number;
  createdAt: string;
}

export interface OrgSummary {
  id: string;
  slug: string;
  name: string;
  role: { key: string; name: string };
}

export interface Organization {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  settings: { invitationExpiryDays: number };
  createdAt: string;
}

export interface Membership {
  memberId: string;
  organizationId: string;
  role: { id: string; key: string; name: string; permissions: string[] };
  title: string | null;
  joinedAt: string;
}

export interface Member {
  id: string;
  userId: string;
  displayName: string;
  email: string;
  role: { id: string; key: string; name: string };
  title: string | null;
  status: string;
  joinedAt: string;
}

export interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
  permissions: string[];
  isSystem: boolean;
}

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface Invitation {
  id: string;
  email: string;
  role: { id: string; key: string; name: string };
  status: InvitationStatus;
  expiresAt: string;
  createdAt: string;
}

export interface InvitationPreview {
  organization: { name: string; slug: string };
  role: { name: string };
  emailHint: string;
  expiresAt: string;
}

export interface Department {
  id: string;
  name: string;
  description: string | null;
  parentId: string | null;
  createdAt: string;
}

export interface Team {
  id: string;
  name: string;
  description: string | null;
  departmentId: string | null;
  visibility: 'public' | 'private';
  memberCount: number;
  myRole: 'lead' | 'member' | null;
  createdAt: string;
}

export interface TeamMember {
  userId: string;
  displayName: string;
  email: string;
  role: 'lead' | 'member';
  joinedAt: string;
}

export interface Workspace {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  description: string | null;
  visibility: 'open' | 'private';
  myRole: 'admin' | 'member' | 'guest' | null;
  archivedAt: string | null;
  createdAt: string;
}

export interface WorkspaceMember {
  userId: string;
  role: string;
  joinedAt: string;
}

export interface ThreadSummary {
  replyCount: number;
  lastReplyAt: string | null;
  /** The first people who replied. */
  participantUserIds: string[];
}

export interface Reaction {
  emoji: string;
  count: number;
  /** The signed-in person reacted with it. */
  reacted: boolean;
}

/** A file attached to a message: a snapshot taken when it was attached. */
export interface MessageAttachment {
  fileId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface Message {
  id: string;
  channelId: string;
  senderUserId: string | null;
  type: 'standard' | 'system';
  /** null once deleted: the content is erased, not hidden. */
  body: string | null;
  clientMessageId: string | null;
  /** Set on thread replies; replies are not part of the timeline. */
  threadRootId: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  thread: ThreadSummary | null;
  reactions: Reaction[];
  /** People mentioned with `<@id>` tokens in the body. */
  mentionedUserIds: string[];
  /** The signed-in person saved it. */
  bookmarked: boolean;
  /** Always sent by the server; optional so that older cached data still type-checks. */
  attachments?: MessageAttachment[];
}

/** A message with the messages around it, oldest first (GET …/messages/{id}/context). */
export interface MessageContext<T> {
  data: T[];
  /** The timeline message to highlight; the thread root when the requested message is a reply. */
  targetId: string;
  isReply: boolean;
  replyId: string | null;
}

export interface Channel {
  id: string;
  workspaceId: string;
  name: string;
  topic: string | null;
  description: string | null;
  type: 'public' | 'private';
  isDefault: boolean;
  isMember: boolean;
  myRole: 'admin' | 'member' | null;
  archivedAt: string | null;
  createdAt: string;
}

export interface Session {
  id: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  current: boolean;
}

export interface Participant {
  userId: string;
  role: 'admin' | 'member';
  joinedAt: string;
}

export interface Conversation {
  id: string;
  kind: 'direct' | 'group';
  title: string | null;
  createdByUserId: string;
  participants: Participant[];
  myRole: 'admin' | 'member';
  createdAt: string;
  lastMessageAt: string | null;
  lastActivityAt: string;
  /** 0–100; 100 means "100 or more". */
  unreadCount: number;
  lastReadMessageId: string | null;
}

export interface ConversationMessage extends Omit<Message, 'channelId'> {
  conversationId: string;
}

/** A page of the timeline; the unread fields describe the signed-in person's read cursor. */
export interface MessagePage<T> extends Page<T> {
  unreadCount?: number;
  lastReadMessageId?: string | null;
}

export interface SavedMessage extends Omit<Message, 'channelId'> {
  conversationId: string;
  kind: 'channel' | 'direct' | 'group';
  channelId: string | null;
  workspaceId: string | null;
  savedAt: string;
}

/** A file the signed-in person uploaded (files service). `mimeType` is detected by the server from the content. */
export interface StoredFile {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  status: 'pending_upload' | 'scanning' | 'available' | 'quarantined' | 'deleted';
  uploadedByUserId: string;
  createdAt: string;
  updatedAt: string;
}
