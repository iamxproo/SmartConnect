# API endpoints (v1)

The contract the web app and the services share. Base URL: the API gateway, `http://127.0.0.1:3000/api/v1` locally. Rules: [conventions.md](conventions.md).

**Conventions used throughout:**
- **Errors:** RFC 9457 `application/problem+json`; clients branch on `code`.
- **Lists:** `{ data: [...], nextCursor: string | null }`, paged with `?limit` (1–100, default 50) and `?cursor` where the collection can grow. Department and team lists are bounded (500) and return `nextCursor: null`.
- **Authentication:** every route needs `Authorization: Bearer <accessToken>` unless marked **public**. Ids are UUIDs.
- **Not visible = 404:** a resource the caller may not see answers 404, exactly like a missing one, so responses are no existence oracle.
- **Statuses:** 401 means re-authenticate. 403 means visible but not allowed. 422 means validation failed, with `errors[]`.

Tenant rules ([product rules](../product/roadmap.md)):
- Organizations are created only by authorized administrators.
- People join through invitations sent to their email address.
- Organization membership grants no access to private workspaces, private teams or private channels.
- Workspace membership grants no access to private channels.

## Identity (`/auth`)

Existing ([identity README](../../smartconnect-backend/services/identity/README.md#api-all-under-apiv1auth)):
- public: `register`, `login`, `refresh`, `logout`, `password/forgot`, `password/reset`;
- bearer: `logout-all`, `sessions`, `sessions/{id}`, `sessions/revoke-others`, `password/change`.

| Method & path | Body → response |
|---|---|
| `GET /auth/me` | → `{ id, email, emailVerified, displayName, platformRoles, passwordChangeRequired }`. `platformRoles` is `[]` for almost everyone ([ADR 0015](../decisions/0015-platform-administration.md)) |
| `POST /auth/email/verify` (public) | `{ token }` → 204. `400 invalid_verification_token` |
| `POST /auth/email/verification` | → 202; sends a new verification email if the address is not verified yet |

Registration sends a verification email. Verifying the email is required to create an organization and to accept invitations. Email links point to the web app with the token in the URL **fragment**: `/verify-email#token=…`, `/reset-password#token=…`, `/invitations/accept#token=…`.

## Platform administration (`/admin`)

Decisions: [ADR 0015](../decisions/0015-platform-administration.md) (Proposed). Super Admin only, read-only. Sign-in is the ordinary `POST /auth/login` (the web app's `/admin/login` page).

**Who gets in:**
- Each service checks the `super_admin` platform role on every request; the role is never in the token.
- **Without the role:** `403 platform_admin_required`. Organization owners and admins have no platform role.
- **Still holding the issued initial password:** `403 password_change_required`. Change it with `POST /auth/password/change`.
- **Nothing else** under `/admin` is routed.

| Method & path | Response |
|---|---|
| `GET /admin/accounts/summary` | → `{ total, verified, active, suspended, deactivated, superAdmins }` (deleted accounts not counted) |
| `GET /admin/organizations?limit&cursor` | → `{ data: [{ id, slug, name, status, memberCount, createdAt }], total, nextCursor }`, newest first. Directory fields only |

A Super Admin is not a member of any organization: `/orgs/{orgId}/…` answers 404 as for anyone else, and a Super Admin never creates organizations (ADR 0015, kept by ADR 0017).

## Organizations (`/orgs`)

Shapes:
- `Organization`: `{ id, slug, name, description, status, settings: { invitationExpiryDays }, createdAt }`
- `Membership`: `{ memberId, organizationId, role: { id, key, name, permissions[] }, title, joinedAt }`
- `Member`: `{ id, userId, displayName, email, role: { id, key, name }, title, status, joinedAt }`
- `Role`: `{ id, key, name, description, permissions[], isSystem }`

Permissions (catalogue):
- `organization.update`, `members.invite`, `members.manage`, `workspaces.create`, `departments.manage`, `teams.manage`.
- System roles: `owner` has all (`*`); `admin` has every catalogue permission; `member` has none.
- Only owners can grant or remove the `owner` role. The last owner can neither leave nor be removed.

| Method & path | Who | Body → response |
|---|---|---|
| `GET /orgs` | any | → `{ data: [{ id, slug, name, role: { key, name } }] }` (the caller's organizations) |
| `GET /orgs/creation-eligibility` | any | → `{ allowed, reason: null \| not_allowed \| email_not_verified \| limit_reached }`: whether `POST /orgs` would be allowed now |
| `POST /orgs` | per `ORGANIZATION_CREATION` (ADR 0017): `open` = any verified account, up to `ORGANIZATION_MAX_OWNED_PER_USER` owned (allowlisted creators exempt); `allowlist` = listed, verified emails. Never a Super Admin | `{ name, slug, description? }` → `201 Organization`; caller becomes `owner`. The same request again (same handle and name, created and still owned by the caller) → `200` with that organization. `name` needs a letter or digit and no control or text-direction characters; `slug` may not be shaped like an id. `403 organization_creation_not_allowed`, `403 email_not_verified`, `403 organization_limit_reached`, `409 slug_taken`, `429` (10 per hour per person, 20 per client address) |
| `GET /orgs/{orgId}` | member | → `Organization` |
| `PATCH /orgs/{orgId}` | `organization.update` | `{ name?, description?, settings?: { invitationExpiryDays (1–30) } }` → `Organization` |
| `GET /orgs/{orgId}/me` | member | → `Membership` |
| `GET /orgs/{orgId}/roles` | member | → `{ data: Role[] }` |
| `GET /orgs/{orgId}/members?userId&q&limit&cursor` | member | → list of `Member`. `userId` filters; repeat it to look up several people at once (at most 100). `q` (1-100 characters) is a case-insensitive substring match on display name or email; `%`, `_` and `\` are literal. Filters combine. Only active members are returned |
| `PATCH /orgs/{orgId}/members/{memberId}` | `members.manage` | `{ roleId?, title? }` → `Member` |
| `DELETE /orgs/{orgId}/members/{memberId}` | `members.manage`, or self (leave) | → 204 |

### Invitations

`Invitation`: `{ id, email, role: { id, key, name }, status: pending|accepted|revoked|expired, expiresAt, acceptedAt, createdAt, delivery }`. `delivery` is where the latest email stands: `queued`, `sent`, `failed`, `disabled` (delivery turned off) or `unknown` (the server restarted, or another instance sent it). A `failed` invitation is still valid: resend it.

| Method & path | Who | Body → response |
|---|---|---|
| `POST /orgs/{orgId}/invitations` | `members.invite` | `{ email, roleId }` → `201 Invitation` (`delivery` says whether the email went out). `409 invitation_pending`, `409 already_member`, `403 owner_required` (only owners invite owners) |
| `GET /orgs/{orgId}/invitations?status&limit&cursor` | `members.invite` | → list of `Invitation`, newest first. `status`: `pending` (default), `accepted`, `revoked`, `expired` or `all` |
| `POST /orgs/{orgId}/invitations/{id}/resend` | `members.invite` | → `Invitation` (new token and expiry; the old link stops working). Pending or expired invitations; an expired one is renewed unless a newer one is pending (`409 invitation_pending`) or the person has joined (`409 already_member`). `409 invitation_not_pending` for accepted or revoked |
| `DELETE /orgs/{orgId}/invitations/{id}` | `members.invite` | → 204 (revoked) |
| `POST /invitations/preview` (public) | token holder | `{ token }` → `{ organization: { name, slug }, role: { name }, emailHint, expiresAt }`. `404 invitation_invalid` |
| `POST /invitations/accept` | the invited person | `{ token }` → `{ organizationId, membership: Membership }`. `404 invitation_invalid`, `403 email_not_verified`, `403 invitation_email_mismatch`, `409 already_member` |

Tokens travel only in request bodies (never URLs), are single-use, expire, and are stored as SHA-256 hashes.

### Departments and teams

- `Department`: `{ id, name, description, parentId, createdAt }`
- `Team`: `{ id, name, description, departmentId, visibility: public|private, memberCount, myRole: lead|member|null, createdAt }`
- `TeamMember`: `{ userId, displayName, email, role: lead|member, joinedAt }`

| Method & path | Who | Body → response |
|---|---|---|
| `GET /orgs/{orgId}/departments` | member | → `{ data: Department[] }` |
| `POST /orgs/{orgId}/departments` | `departments.manage` | `{ name, description?, parentId? }` → `201 Department` |
| `PATCH /orgs/{orgId}/departments/{id}` | `departments.manage` | `{ name?, description?, parentId? }` → `Department` (no cycles) |
| `DELETE /orgs/{orgId}/departments/{id}` | `departments.manage` | → 204. `409 department_not_empty` |
| `GET /orgs/{orgId}/teams?departmentId` | member | → `{ data: Team[] }`: public teams and teams the caller belongs to. Management rights do **not** reveal private teams |
| `POST /orgs/{orgId}/teams` | `teams.manage` | `{ name, description?, departmentId?, visibility }` → `201 Team`; the creator becomes the team's lead |
| `GET /orgs/{orgId}/teams/{id}` | visible teams | → `Team` |
| `PATCH /orgs/{orgId}/teams/{id}` | `teams.manage`, team visible to the caller | `{ name?, description?, departmentId?, visibility? }` → `Team` |
| `DELETE /orgs/{orgId}/teams/{id}` | `teams.manage`, team visible to the caller | → 204 |
| `GET /orgs/{orgId}/teams/{id}/members` | visible teams | → `{ data: TeamMember[] }` |
| `PUT /orgs/{orgId}/teams/{id}/members/{userId}` | `teams.manage` or team lead | `{ role }` → `TeamMember`; the user must be an organization member |
| `DELETE /orgs/{orgId}/teams/{id}/members/{userId}` | `teams.manage`, team lead, or self | → 204 |

## Workspaces and channels (`/orgs/{orgId}/workspaces`)

- `Workspace`: `{ id, organizationId, name, slug, description, visibility: open|private, myRole: admin|member|guest|null, archivedAt, createdAt }`
- `WorkspaceMember`: `{ userId, role, joinedAt }`. Names come from the organization member list.
- `Channel`: `{ id, workspaceId, name, topic, description, type: public|private, isDefault, isMember, myRole: admin|member|null, archivedAt, createdAt }`

| Method & path | Who | Body → response |
|---|---|---|
| `GET …/workspaces?q&limit&cursor` | org member | → list of `Workspace`: open workspaces, plus private ones the caller belongs to. `q` (1-100 characters): case-insensitive substring of the name, within that set |
| `POST …/workspaces` | `workspaces.create` | `{ name, slug, description?, visibility }` → `201 Workspace`; creator becomes admin; a public `general` channel is created and joined |
| `GET …/workspaces/{wsId}` | open, or member | → `Workspace` |
| `PATCH …/workspaces/{wsId}` | workspace admin | `{ name?, description?, visibility? }` → `Workspace` |
| `POST …/workspaces/{wsId}/join` | org member, open workspace | → `Workspace` (joins the default channels) |
| `POST …/workspaces/{wsId}/leave` | member | → 204. `409 last_admin` |
| `GET …/workspaces/{wsId}/members?limit&cursor` | member | → list of `WorkspaceMember` |
| `PUT …/workspaces/{wsId}/members/{userId}` | workspace admin | `{ role }` → `WorkspaceMember`; the user must be an organization member |
| `DELETE …/workspaces/{wsId}/members/{userId}` | workspace admin | → 204. `409 last_admin` |
| `GET …/channels?q&limit&cursor` | org member | → list of `{ id, workspaceId, workspaceName, name, type, isMember, archivedAt }`: every channel the caller can see across the workspaces they belong to (public channels, private ones they are in; guests: only their own). Never includes a channel of a workspace the caller is not in. `q` optional (1-100 characters, substring of the name). Cursor-paginated by id |
| `GET …/workspaces/{wsId}/channels?limit&cursor` | member | → list of `Channel`: public channels, plus private ones the caller belongs to (guests: only their own) |
| `POST …/workspaces/{wsId}/channels` | member | `{ name, topic?, description?, type }` → `201 Channel`; creator becomes channel admin. `409 channel_name_taken` |
| `GET …/channels/{chId}` | public: member; private: channel member | → `Channel` |
| `POST …/channels/{chId}/join` | member, public channel | → `Channel` |
| `POST …/channels/{chId}/leave` | channel member | → 204 |
| `GET …/channels/{chId}/members?limit&cursor` | visible channel | → list of `{ userId, role, joinedAt }` |
| `PUT …/channels/{chId}/members/{userId}` | channel admin (private) or member (public) | `{ role? }` → member; the user must be a workspace member |
| `DELETE …/channels/{chId}/members/{userId}` | channel admin, or self | → 204 |

(`…` = `/orgs/{orgId}`; channel paths are `/orgs/{orgId}/workspaces/{wsId}/channels/…`.)

**Last admins:** the last workspace admin, and the last admin of a private channel, cannot leave or be demoted (`409 last_admin`). When a workspace admin removes a private channel's sole admin, the longest-standing remaining member becomes admin. Decisions: [ADR 0010](../decisions/0010-organizations-and-membership.md).

## Channel messages (`…/workspaces/{wsId}/channels/{chId}/messages`)

`Message`: `{ id, channelId, senderUserId, type: standard|system, body: string | null, clientMessageId: string | null, threadRootId: string | null, createdAt, editedAt, deletedAt, thread: ThreadSummary | null, reactions: Reaction[], mentionedUserIds: string[], bookmarked: boolean }`. `body` is `null` for deleted messages; the content is erased, not hidden.

- `ThreadSummary`: `{ replyCount, lastReplyAt, participantUserIds }` (the first 20 repliers), on a root message that has replies.
- `Reaction`: `{ emoji, count, reacted }`, in the order first used; `reacted` is about the caller. At most 20 different emoji per message.
- `mentionedUserIds`: the users mentioned with `<@USER_UUID>` tokens in `body` (at most 50, distinct). `bookmarked`: the caller saved the message.
- `attachments`: `[{ fileId, name, mimeType, sizeBytes }]`, a snapshot taken when the file was attached (ADR 0013, decision 6).
- The same fields are on `ConversationMessage` (with `conversationId` instead of `channelId`).

Access is decided by the workspace service on every request, asked as the caller:
- reading needs the channel to be **visible** to the caller;
- posting needs channel **membership**.

| Method & path | Who | Body → response |
|---|---|---|
| `GET …/messages?limit&cursor` | visible channel | → list of top-level `Message`, **newest first**, plus the caller's `unreadCount` (capped at 100) and `lastReadMessageId`. `nextCursor` pages to older messages. Thread replies are not listed here |
| `POST …/messages` | channel member | `{ body (1–40 000 chars; may be empty when there are attachments), clientMessageId?, threadRootId?, attachmentFileIds? (≤ 10, distinct: `available` files the caller uploaded; otherwise `422 invalid_attachment`, the same answer for other people's, pending and missing files; `503` when the files service cannot answer) }` → `201 Message`. Repeating the same `clientMessageId` returns the original message (200), so retries never duplicate. With `threadRootId` the message is a reply: the root must be a top-level message of this channel (`404` otherwise), `422 reply_to_reply` for a reply, `409 message_deleted` for a deleted root. `422 invalid_mention` (a mentioned person is not an active member of the organization), `422 too_many_mentions` (over 50). `409 channel_archived`. Posting moves the sender's read cursor |
| `PATCH …/messages/{msgId}` | the sender | `{ body }` → `Message` (sets `editedAt`; mentions are re-validated and re-synced). `403` for others, `409 message_deleted` |
| `DELETE …/messages/{msgId}` | the sender, or a channel admin (moderation) | → 204; erases `body`, mentions and reactions |
| `GET …/messages/{msgId}/replies?limit&cursor` | visible channel | → list of `Message`, **oldest first**. `404` when `msgId` is not a top-level message of the channel |
| `PUT …/messages/{msgId}/reactions/{emoji}` | channel member | → 204, idempotent. `{emoji}` is URL-encoded: one Unicode emoji sequence of at most 64 bytes (`422 invalid_emoji`). `409 message_deleted`, `409 channel_archived`, `409 too_many_reactions` |
| `DELETE …/messages/{msgId}/reactions/{emoji}` | visible channel | → 204, idempotent; removes the caller's reaction |
| `PUT …/messages/{msgId}/bookmark` | visible channel | → 204, idempotent. Saves the message for the caller. `409 message_deleted` |
| `DELETE …/messages/{msgId}/bookmark` | visible channel | → 204, idempotent |
| `POST …/messages/read` | visible channel | `{ messageId }` → 204. Moves the caller's read cursor forward only; replies cannot be read-marked (`404`) |
| `GET …/messages/{msgId}/context?before&after` | visible channel | → `{ data: [older…, target, …newer], targetId, isReply, replyId }`: up to 25 top-level neighbours on each side (default 10), oldest first. For a reply, the context of its root, with `isReply: true`. `404` for a reply whose root was deleted |
| `PUT …/messages/preferences` | visible channel | `{ level: all\|mentions\|none }` → 204. The caller's notification level for this channel (`all` removes the setting) |

New and changed messages are announced over Socket.IO (see Realtime below). Clients then refetch.

## Conversations: direct and group (`/orgs/{orgId}/conversations`)

Decisions: [ADR 0011](../decisions/0011-direct-and-group-conversations.md) (Proposed). Served by the messaging service.

Every route checks the caller's organization membership, asked as the caller on every request.

**Participants only.** Anyone else gets 404, exactly as for a missing id; that includes organization owners. Channel conversations are never reachable here.

**Objects**
- `Conversation`: `{ id, kind: direct|group, title: string|null, createdByUserId, participants: Participant[], myRole: admin|member, createdAt, lastMessageAt: string|null, lastActivityAt, unreadCount (0–100, capped), lastReadMessageId: string|null }`.
- `Participant`: `{ userId, role: admin|member, joinedAt }`. In direct conversations, both participants are `member`.
- `ConversationMessage`: `{ id, conversationId, senderUserId, type: standard|system, body: string|null, clientMessageId: string|null, createdAt, editedAt, deletedAt }`.

**History starts at the caller's `joinedAt`:** older messages are not returned, editable or countable for that caller.

| Method & path | Who | Body → response |
|---|---|---|
| `GET …/conversations?limit&cursor` | member | → list of `Conversation`, ordered by `lastActivityAt` (newest first), then `id` |
| `POST …/conversations/direct` | member | `{ userId }` → `201 Conversation` (created) or `200` (it already existed). `422 cannot_message_self`, `422 user_not_in_organization` |
| `POST …/conversations/groups` | member | `{ title?: string (1–120) \| null, userIds: string[] (2–49 distinct others) }` → `201 Conversation`; the caller becomes `admin`. `422 user_not_in_organization` |
| `GET …/conversations/inbox` | member | → `{ organizationId }`. Used by the realtime gateway before it joins a socket to the caller's inbox; leftover conversation memberships from an earlier organization membership are dropped first |
| `GET …/conversations/{id}` | participant | → `Conversation` |
| `PATCH …/conversations/{id}` | group admin | `{ title: string (1–120) \| null }` → `Conversation`. `409 not_a_group` |
| `PUT …/conversations/{id}/participants/{userId}` | group admin | `{ role?: admin\|member }` → `201 Participant` (added) or `200` (role changed). `409 not_a_group`, `409 conversation_full` (50), `409 last_admin`, `422 user_not_in_organization` |
| `DELETE …/conversations/{id}/participants/{userId}` | group admin, or self (leave) | → 204. The longest-standing participant becomes admin when the last admin leaves. `409 not_a_group` |
| `POST …/conversations/{id}/read` | participant | `{ messageId }` → 204. Moves the read cursor forward only |
| `GET …/conversations/{id}/messages?limit&cursor` | participant | → list of top-level `ConversationMessage`, **newest first**, plus the caller's `unreadCount` and `lastReadMessageId`. Replies are not listed |
| `POST …/conversations/{id}/messages` | participant | `{ body, clientMessageId?, threadRootId?, attachmentFileIds? }` → `201` (or `200` replay), as for channels, attachments included. Also moves the sender's read cursor (not for replies). Only participants can be mentioned (`422 invalid_mention`). `409 participant_inactive` (direct: the other person left the organization) |
| `PATCH …/conversations/{id}/messages/{msgId}` | the sender | `{ body }` → `ConversationMessage`. `409 message_deleted` |
| `DELETE …/conversations/{id}/messages/{msgId}` | the sender, or a group admin | → 204; erases `body` |
| `GET …/conversations/{id}/messages/{msgId}/context?before&after` | participant | → as for channels, from the caller's join onward |
| `GET …/conversations/{id}/messages/{msgId}/replies?limit&cursor` | participant | → list of `ConversationMessage`, **oldest first**. History from the join applies to the root |
| `PUT` / `DELETE …/conversations/{id}/messages/{msgId}/reactions/{emoji}` | participant | → 204, idempotent; as for channels |
| `PUT` / `DELETE …/conversations/{id}/messages/{msgId}/bookmark` | participant | → 204, idempotent; as for channels |

## Saved messages (`GET /orgs/{orgId}/saved-messages?limit&cursor`)

Organization member. → list of `SavedMessage` (a message as above plus `conversationId`, `kind: channel|direct|group`, `channelId`, `workspaceId`, `savedAt`), most recently saved first. **Visibility is checked again on every read:** channel messages through the workspace service as the caller (at most one call per distinct channel per request), conversation messages through participation and history from the join. A message the caller can no longer see is left out and its content never returned; deleted messages are left out. A page may hold fewer than `limit` items while `nextCursor` is set: one request checks at most 20 distinct channels. `503` when the workspace service cannot answer. At most 500 saved messages per person and organization (`409 too_many_bookmarks`).


## Message and file search (`GET /orgs/{orgId}/message-search`)

Organization member. ADR 0013, decision 7. Parameters: `q` (1-200 characters, required; `websearch` syntax: `"phrase"`, `-exclude`, `or`), `from` (user id), `channelId` **or** `conversationId` (both: 422), `before` (exclusive) and `after` (inclusive) as ISO dates, `has=file`, `type=messages|files` (default `messages`), `limit` (1-50, default 20), `cursor`. → `{ data, nextCursor }`, newest first, no totals.
- **Scope, in SQL:** channels the workspace service lists for the caller (every page, as the caller), plus the caller's direct and group conversations from their join. Never deleted messages; a reply only while its root is visible and not deleted. A filter outside the scope answers `200 { data: [], nextCursor: null }`, the same as no hits. `503` when the workspace service cannot answer.
- `type=messages`: a message as above plus `location: { kind: 'channel', workspaceId, channelId } | { kind: 'direct'|'group', conversationId }`.
- `type=files`: attachment names (`ILIKE`, `%` `_` `\` escaped) → `{ fileId, name, mimeType, sizeBytes, messageId, location, createdAt }`.

## Attachment access (`GET /orgs/{orgId}/attachments/{fileId}`)

Organization member. → `200 { fileId }` when the caller can see at least one non-deleted message that attaches the file, otherwise `404`. Channels are checked through the workspace service as the caller (at most 20 distinct channels, `503` when it cannot answer); direct and group conversations through participation and history from the join. Replies under a deleted root grant nothing. The files service asks this, as the caller, to authorize everyone except a file's uploader.

## Activity and notification levels (ADR 0013, decisions 8 and 9)

`ActivityItem`: `{ id: "<kind>:<messageId>", kind: mention|thread_reply, message: { id, senderUserId, excerpt (plain text, ≤ 200 characters, mention tokens kept as <@id>), createdAt, threadRootId }, location, unread }`. Items are the caller's mentions and replies in threads the caller takes part in, never the caller's own messages. A reply that mentions the caller is one `mention` item. **Visibility is checked on every read** (the caller's visible channels, participation, history from the join); deleted messages are never items. A notification level of `none` hides a conversation's items; `mentions` hides its thread replies.

| Method & path | Who | Body → response |
|---|---|---|
| `GET /orgs/{orgId}/activity?filter=all\|unread\|mentions\|threads&limit&cursor` | member | → list of `ActivityItem`, newest first (`limit` ≤ 100, default 30) |
| `GET /orgs/{orgId}/activity/unread-count` | member | → `{ count }`, capped at 100 |
| `POST /orgs/{orgId}/activity/read` | member | `{ itemIds: string[] (1–100) }` → 204. Ids that are not the caller's visible activity are ignored |
| `POST /orgs/{orgId}/activity/read-all` | member | → 204 |
| `PUT /orgs/{orgId}/conversations/{id}/preferences` | participant | `{ level: all\|mentions\|none }` → 204 |
| `GET /orgs/{orgId}/notification-preferences` | member | → `{ data: [{ location, level }] }`: the caller's levels that differ from `all`, for places the caller can still see |

Channel mentions are not pushed over Socket.IO (that would reveal channels to people who cannot see them): clients refetch on their existing events and poll the unread count.

## Files (`/orgs/{orgId}/files`)

Decisions: [ADR 0013](../decisions/0013-collaboration-platform-expansion.md) (Proposed), decision 2. Served by the files service (:3106); the two `…/content` routes stream raw bytes through the gateway, everything else is JSON.

**Objects**
- `File`: `{ id, name, mimeType, sizeBytes, status: pending_upload|available|…, uploadedByUserId, createdAt, updatedAt }`. `mimeType` is `application/octet-stream` until the upload completes, then **detected from the content** (PNG, JPEG, GIF, WebP, PDF, UTF-8 text, Office documents; anything else stays `application/octet-stream`). `name` has path separators, control and direction-override characters removed.

**Who can read a file:** its uploader; otherwise anyone the messaging service says can see a message that attaches it (`GET /api/v1/orgs/{o}/attachments/{fileId}` as the caller: 200 = yes, 404 = no, anything else fails closed with 503). Everyone else gets 404.

| Method & path | Who | Body → response |
|---|---|---|
| `POST …/files` | member | `{ name (1–1024), sizeBytes (1–max) }` → `201 File` (`pending_upload`). `422` for a bad name or a size above the maximum (default 25 MiB), `507 storage_quota_exceeded` if it would pass the storage budget, `503 storage_unavailable` while the stored total cannot be counted |
| `PUT …/files/{id}/content` | uploader, once | Raw bytes, `Content-Type: application/octet-stream`, `Content-Length` required at the gateway → `200 File` (`available`). `413` more than declared or above the maximum, `422 size_mismatch` fewer than declared (the file stays `pending_upload`, retry), `409 already_uploaded`, `415`, `507 storage_quota_exceeded`, `503 storage_unavailable` (with `Retry-After`; the file is retired, never left half-made) |
| `GET …/files?limit&cursor` | member | → list of my `available` files, newest first |
| `GET …/files/{id}` | reader | → `File` |
| `GET …/files/{id}/content` | reader | → the bytes. `Content-Type` (detected), `Content-Length`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, no-store`, `Content-Disposition: inline` for PNG/JPEG/GIF/WebP only and `attachment` (RFC 5987 `filename*`) otherwise |
| `GET …/files/{id}/download-url` | reader | → `{ url, expiresAt }`: a presigned link to the bytes in object storage (Cloudflare R2), valid `FILES_SIGNED_URL_TTL_SECONDS` (default 60), for that one object with the same type and disposition as `…/content`. `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`. `404 signed_urls_unavailable` when the server stores files locally. Optional: the web app keeps using `…/content` |
| `DELETE …/files/{id}` | uploader | → 204. The bytes are removed and the file is unreadable for everyone |

Gateway limits: uploads are rate-limited per user (100 per hour) and capped at `FILES_MAX_BYTES`. A storage outage answers `503 storage_unavailable` on uploads and downloads.


## Realtime (`realtime-gateway`, Socket.IO; [ADR 0004](../decisions/0004-realtime-gateway.md))

Socket.IO on the realtime gateway (`http://127.0.0.1:3105` locally), path `/realtime/socket.io`, WebSocket transport only.

- **Handshake:** `auth: { token: <accessToken> }`.
  - A missing, invalid or expired token refuses the connection (`connect_error` with `message: "unauthenticated"`).
  - The socket is disconnected when its token expires; reconnect with a fresh token.
  - Browser origins must be in the allow-list.
- **Subscribing:** `emit('subscribe', { organizationId, workspaceId, channelId }, ack)`.
  - The gateway asks the workspace service, **as the socket's user**, whether the channel is visible. `ack({ ok: true })` or `ack({ ok: false, code: 'not_found' | 'unavailable' | 'invalid' })`.
  - Visibility is re-checked periodically: a user who loses access is removed from the room and gets `emit('unsubscribed', { channelId })`.
  - `emit('unsubscribe', { channelId })` leaves a room.
  - **Limits:** 30 subscribe attempts per socket per minute, and at most `MAX_CHANNELS_PER_SOCKET` rooms (default 200). Beyond either limit, the ack is `unavailable`. A user may hold `MAX_SOCKETS_PER_USER` sockets (default 10); extra sockets are disconnected by the server.
  - **Client behaviour:** after `unavailable` or `unsubscribed`, retry `subscribe` with backoff. `not_found` is final.
- **Server event:** `message.changed` → `{ type: 'created' | 'updated' | 'deleted', organizationId, workspaceId, channelId, messageId }`.
  - **Identifiers only:** clients fetch the content through the REST API, which authorizes again. A realtime path can never expose content the REST API would not.
- **Conversation inbox ([ADR 0011](../decisions/0011-direct-and-group-conversations.md)):**
  - **Subscribing:** `emit('inbox.subscribe', { organizationId }, ack)`. The gateway asks messaging, as the socket's user, `GET …/conversations/inbox`, then joins their own inbox room for that organization.
    - The acks are the same as for channels.
    - The subscription counts towards the room cap and the subscribe rate limit.
    - It is re-checked periodically; on loss the gateway emits `inbox.unsubscribed` → `{ organizationId }`.
  - **Unsubscribing:** `emit('inbox.unsubscribe', { organizationId })`.
  - **Server event `conversation.changed`** → `{ organizationId, conversationId, change, messageId: string | null }`. `change` is one of `message.created`, `message.updated`, `message.deleted`, `conversation.updated` or `read`.
  - **Who receives it:** only the users messaging names for that change: participants, plus removed people for `conversation.updated`, and only the reader for `read`.
  - **Identifiers only.**
- **Missed events:** none are replayed. After a reconnect, clients refetch the newest page of each open channel (`GET …/messages`). There are no typing or presence events yet.
