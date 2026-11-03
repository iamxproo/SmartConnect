# 0013. Collaboration platform expansion: messaging features, files, search and activity

- Status: **Proposed**
- Date: 2026-11-03
- Builds on:
  - [ADR 0010](0010-organizations-and-membership.md): cross-service authorization with the caller's own token.
  - [ADR 0011](0011-direct-and-group-conversations.md): conversations.
  - [ADR 0006](0006-object-storage-and-file-security.md): files. This record deviates from it, as noted in decision 2.
- Contract details: [api/endpoints.md](../api/endpoints.md), updated by each module as it lands.

## Context

The platform mission asks for threads, reactions, mentions, files, search, notifications, meetings and integrations.

Architectural facts that constrain the design (verified 2026-11-03):
1. **No event relay:** [ADR 0002](0002-event-broker-nats-jetstream.md) is Proposed and not implemented. A service cannot create data for *another* user in *another* service. Cross-service authorization works only "as the caller", and no service credentials exist.
2. **The API gateway is JSON only:** it re-serializes request bodies and buffers responses (kit `requireJsonBodies`, `UpstreamProxy`). File bytes cannot pass through it today.
3. **The messaging schema already models what is needed:** threads (`thread_root_id`, `message_threads`), reactions, mentions, bookmarks, attachments (`message_attachments.file_id`) and read cursors. The files schema models `files` and `file_versions`.
4. **No media server:** LiveKit ([ADR 0005](0005-meetings-livekit.md)) is Proposed and needs a budget decision.

## Decision

1. **Messaging features** (owner: messaging service). The same rules apply to channels and to direct and group conversations, through the shared message store.
   - **Threads:**
     - A post may carry `threadRootId` (a top-level message of the same conversation). Replies to replies are not allowed.
     - Reading replies needs the same access as reading the root.
     - A root message carries `thread: { replyCount, lastReplyAt, participantUserIds } | null`.
   - **Reactions:**
     - `PUT` and `DELETE …/messages/{id}/reactions/{emoji}`. An emoji is one Unicode emoji sequence, at most 64 bytes.
     - Only people who may post there may react.
     - A message carries `reactions: [{ emoji, count, reacted }]`.
   - **Mentions:**
     - The body token is `<@USER_UUID>`. The server stores up to 50 user mentions per message, and re-syncs them on edit.
     - In direct and group conversations, only participants can be mentioned. In channels, any active organization member can be mentioned.
     - Activity is filtered by what the mentioned person can see *when they read it*, so a mention never reveals a channel.
     - `@channel` and `@here` are not built.
   - **Read state:** channels get the same forward-only read cursor as conversations. History responses carry `unreadCount` and `lastReadMessageId` for the caller.
   - **Saved messages (bookmarks):** `PUT` and `DELETE …/messages/{id}/bookmark`, plus `GET /orgs/{o}/saved`. Visibility is re-checked when the list is read: a message the caller can no longer see is not returned.
   - **Formatting:** a safe Markdown subset is rendered by the client: bold, italic, strikethrough, inline code, code blocks, quotes, and auto-linked `http(s)` URLs with `rel="noopener noreferrer"`. It is never rendered as HTML from the server.
   - **Deferred:**
     - Edit history and pins: there is no table for them.
     - Forwarding: it would re-share private content, so it needs a product decision.
     - Server-side link previews: they would fetch arbitrary URLs (SSRF and external traffic).

2. **Files: a new files service** (`services/files`, :3106 locally).

   **Storage:**
   - An interface with a **local-filesystem driver** for development. Its directory is outside any served path, and it is gitignored.
   - Keys are always server-generated (`<org>/<file>/<version>`). Object storage (ADR 0006) slots in later behind the same interface.

   **Upload:**
   - `POST /orgs/{o}/files { name, sizeBytes }` creates a file with status `pending_upload`, owned by the uploader.
   - `PUT /orgs/{o}/files/{id}/content` with raw bytes:
     - the size limit is enforced while streaming;
     - the type is detected from the **content** (magic bytes) and never from the extension or the client's type alone;
     - the SHA-256 is computed;
     - the status becomes `available`.
   - Any active organization member may upload.

   **Who may read a file:**
   - Its uploader.
   - Anyone **messaging** says can see a message that attaches it. The files service asks messaging as the caller, as the workspace service asks the organization service today.
   - Until attachments exist, only uploaders can read.
   - This replaces ADR 0006's "owning service asks files for a presigned URL", which needs service credentials that do not exist.

   **Download:**
   - `GET /orgs/{o}/files/{id}/content` streams the bytes with `X-Content-Type-Options: nosniff` and a restrictive `Content-Security-Policy`.
   - `Content-Disposition: inline` applies only to PNG, JPEG, GIF and WebP. Never to SVG or HTML, and PDFs too are always downloads.

   **Gateway:** a dedicated streaming route for exactly those two content paths, with its own size limit and rate limits. Every other route stays JSON only.

   **Attachments (later):** a message may attach only files its sender uploaded and that are `available`. Deleting the message removes its attachments, and with them every non-uploader's access.

3. **Search: federated, not projected.** Each owning service searches its own data and authorizes the caller itself. No search index, and no projection that would need the relay.
   - **Members:** `GET /orgs/{o}/members?q=`.
   - **Workspaces:** `GET /orgs/{o}/workspaces?q=`.
   - **Channels:** a new `GET /orgs/{o}/channels?q=`, listing the visible channels across the caller's visible workspaces.
   - **Messages (later):** PostgreSQL full-text search in messaging, limited to the caller's visible channels and conversations, and history-from-join.
   - **Files (later):** search by name among files the caller may read.
   - **Client:** it merges the results. Snippets come only from documents the caller may read.

4. **Activity instead of a notifications service (for now).**
   - Messaging serves `GET /orgs/{o}/activity`: mentions of the caller and replies in threads they take part in. Visibility is re-checked when the list is read.
   - Unread state is the existing read cursor. "Mark as read" and "mark all as read" move cursors forward.
   - Live updates use the existing inbox and channel events.
   - Per-conversation mute preferences live in messaging.
   - **Not built:** the `notifications` service, with its cross-service notifications (invitations, membership changes) and delivery. It waits for an approved relay (ADR 0002), and this record does not approve one.

5. **Blocked, not faked:**
   - **Meetings with audio and video:** blocked by the ADR 0005 decision. Only a meeting lifecycle without media may be built, and the UI must say plainly that there is no audio or video.
   - **Incoming webhooks and bots posting into channels:** these need service-to-service authentication, a new decision.
   - **Email:** deferred to deployment ([ADR 0012](0012-transactional-email-resend.md)).

## Wave 2 contracts (owner: messaging, unless noted)

6. **Attachments:**
   - **Posting:** a message (channel or conversation) may carry `attachmentFileIds` (at most 10, distinct).
     - Messaging asks the files service, as the caller (`GET /orgs/{o}/files/{id}`), and accepts only files whose `uploadedByUserId` is the caller and whose status is `available`.
     - It copies `name`, `mimeType` and `sizeBytes` into `message_attachments` (an additive migration).
     - With attachments, `body` may be empty.
   - **Responses:** messages carry `attachments: [{ fileId, name, mimeType, sizeBytes }]`.
   - **Deleting a message** removes its attachment rows.
   - **`GET /orgs/{o}/attachments/{fileId}`** answers 200 `{ fileId }` only when the caller can see a non-deleted message that attaches the file:
     - channels: workspace visibility, asked as the caller;
     - conversations: participation, with history from join.

     It answers 404 otherwise. The files service uses it to authorize everyone except the uploader.
   - **Context:** `GET …/messages/{id}/context?before&after` (each at most 25) returns the message plus its neighbours, under the same access rules. It is used to jump to a search or activity result.
7. **Message and file search:** `GET /orgs/{o}/message-search`.
   - **Parameters:** `q` (1–200 characters), `from` (a user id), `channelId` or `conversationId`, `before` and `after` (ISO dates), `has=file`, `type=messages|files`, `limit` and `cursor`.
   - **Scope:**
     - the caller's visible channels: the workspace service's `GET /orgs/{o}/channels`, asked as the caller and paged;
     - their direct and group conversations, with history from join.

     Nothing outside that scope is searched or counted.
   - **Messages:** PostgreSQL full-text search (the `simple` configuration, `websearch_to_tsquery`), newest first, with a cursor.
   - **Files:** attachment names within visible messages. The web app adds the caller's own uploads (files service, `GET /orgs/{o}/files?q=`).
   - **Results:**
     - every message field the caller may see, plus its location (`kind` and the ids);
     - the client highlights matches;
     - deleted messages are never returned.
   - **Web:** `from:`, `in:`, `before:`, `after:` and `has:file` are entered as removable chips.
8. **Activity:**
   - **Listing:** `GET /orgs/{o}/activity?filter=all|unread|mentions|threads&limit&cursor`.
     - **Items:** mentions of the caller, and replies in threads the caller takes part in (as root author, replier or mentioned person). Never the caller's own messages.
     - **Visibility** is re-checked on every read (the visible-channels list once per request, plus participation and history from join).
     - **Item shape:** `{ id, kind: mention|thread_reply, message: { id, senderUserId, excerpt (≤ 200 characters, plain text), createdAt, threadRootId }, location, unread }`.
   - **Unread state** has its own tables (additive migration):
     - a per-user `seen_until`;
     - per-item reads.
   - **Endpoints:**
     - `POST /orgs/{o}/activity/read { itemIds }`;
     - `POST /orgs/{o}/activity/read-all`;
     - `GET /orgs/{o}/activity/unread-count` (capped at 100).
   - **Realtime:** channel mentions are **not** pushed. Messaging cannot cheaply tell whether the mentioned person sees the channel, and a push would reveal that it exists. The client refetches on its existing events and polls the unread count.
9. **Notification preferences:**
   - **Setting a level:** a level of `all`, `mentions` or `none` per (user, conversation):
     - `PUT …/channels/{ch}/messages/preferences { level }`;
     - `PUT /orgs/{o}/conversations/{id}/preferences { level }`.
   - **Reading levels:** `GET /orgs/{o}/notification-preferences` lists the caller's levels that differ from `all`.
   - **Effect on activity:** `none` hides that conversation's items; `mentions` hides its thread replies.
   - **Storage:** an additive migration.

## Consequences

- No new infrastructure and no new npm dependency for any of the above.
- Every new read path asks the owning service as the caller. Latency grows with the number of hops (files → messaging → workspace → organization). This is acceptable locally, and caching remains the measured follow-up named in ADR 0010.
- **Migrations:**
  - files: a context value for uploads that are not attached yet;
  - messaging: a full-text index, and whatever pins and mute need.

  All additive. The lead applies them to the dev database after a backup.
- Search results can be at most as fresh as the owning service, because no index exists. Ranking is per service, not global.

## Alternatives considered

| Option | Why not (now) |
|---|---|
| A central search index (the existing `search` schema) fed by events | Needs the relay (ADR 0002) and projections of private content: more to secure |
| A notifications service fed synchronously by producers | Needs service credentials or a relay; neither exists |
| Presigned download URLs (ADR 0006) | Needs a trust relationship between services; revisited when object storage arrives |
| Elasticsearch or OpenSearch | No demonstrated need at this scale; PostgreSQL full-text search first |
