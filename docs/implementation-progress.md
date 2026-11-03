# Implementation progress

This is the single progress report.
- It records facts only: something counts as done only when tests verify it.
- The newest work comes first. The earlier records are kept below it, unchanged.

## Platform administration: development Super Admin

- Date: 2026-11-03, 16:40–17:30 IST.
- Decision: [ADR 0015](decisions/0015-platform-administration.md), **Proposed**.
- **What existed before:** no Super Admin, no `/admin/login` page and no admin panel; only organization roles. So this is a new, small admin system on the **existing** login.
- **The product owner's choices:**
  - build it reusing login;
  - the Admin ID is the email `admin@smartconnect.localhost`;
  - the short initial password is allowed in development only, and must be changed at the first sign-in;
  - the organization-creator allowlist is kept.

**Built:**
- **Identity:**
  - Migration `platform_roles`, additive: a `platform_role_assignments` table (role `super_admin`), plus `credentials.change_required` with a CHECK that allows it only on password credentials.
  - `/auth/me` also returns `platformRoles` and `passwordChangeRequired`.
  - Password change and reset clear the flag. A required change cannot reuse the issued password.
  - `SuperAdminGuard` looks up the role, account status and password state on every request.
  - New endpoint `GET /admin/accounts/summary`.
- **Organization:**
  - Migration `platform_organization_directory`: two SECURITY DEFINER functions that return ids and a count only.
  - `GET /admin/organizations`, where each organization is read in its own tenant context.
  - `SuperAdminGuard` there asks identity through `/auth/me`.
  - A Super Admin gets no organization access and no creation right.
- **Gateway:** exactly two GET admin routes, which need a token and are rate-limited per user. Nothing else under `/admin` is forwarded.
- **Web app:**
  - `/admin/login` uses the ordinary login and signs an account without the role straight back out.
  - `/admin/password` is the forced first change: every page redirects there until it is done.
  - `/admin` is the read-only dashboard (account totals and the organization directory). Accounts without the role see a refusal and no admin API is called.
- **Seed:** `make admin-seed`.
  - It asks for the password twice, with hidden input, in an interactive terminal, and passes it on stdin.
  - `smartconnect-backend/scripts/super-admin.ts` stores it with the identity service's Argon2id hasher.
  - It refuses any `NODE_ENV` but `development` (or unset), and any database but the local development instance.
  - Re-running it resets the password and ends the account's sessions.
- **Not stored anywhere:** the development password is in no file of the repository (checked).

**Verified:**

| Check | Result |
|---|---|
| `make db-test` | **891/891**, including the new identity Super Admin suite (8) and the organization platform-admin suite (6) |
| Browser tests: admin, sign-in, smoke, settings | **10/10**, including a Super Admin through `/admin/login`, the forced change and the dashboard, and an organization owner refused by the page and the API |
| Web app | **404/404** (run serially). Run in parallel under machine load (load average 11–23), timing tests in unchanged org pages fail intermittently; they pass alone and serially |
| Format, lint, Prisma, typecheck, unit tests (27, including 13 seed-guard tests), backend suites (gateway 210, identity 39, organization 20, …), build, audit | Pass |
| `make db-drift` | Every schema matches its migrations |
| `make admin-seed` checked by hand | Refuses production and staging, mismatched entries, short passwords and non-interactive runs, and echoes nothing |

**Dev database:** backed up (`infrastructure/backup/output/smartconnect-20261103T113803Z`), then the two additive migrations were applied. `make db-docs` regenerated the ERD and schema reference. The running services were not restarted.

**Open (before production):** see ADR 0015. They are how Super Admins are granted outside development, MFA, auditing admin reads, and whether a Super Admin may create organizations.

## Organization creators: persistent allowlist

- Date: 2026-11-03, 16:20–16:35 IST.
- **Problem:** every `POST /api/v1/orgs` on the local organization service returned 403 `organization_creation_not_allowed`.
  - **Cause:** `ORGANIZATION_CREATOR_EMAILS` was not set anywhere the service reads, so its allowlist was empty.
  - **ADR 0010 decision 1** fails closed in that case, so nobody could create an organization.

**Built:**
- `make organization-creators`: an interactive script that writes the list to the gitignored `.secrets/organization.env` (mode 600, inside a mode-700 directory).
  - **What it does to the input:** lowercases and de-duplicates addresses, and keeps other keys in the file.
  - **What it refuses:** invalid or empty input, non-interactive runs, and running when `.secrets/` is not gitignored.
  - **What it never does:** print the stored list back.
- **Organization `start` script:** now loads `.env`, then `.secrets/smtp.env`, then `.secrets/organization.env`.
  - `make db-bootstrap` rewrites only each service's own `.env` and `.env.migration`, so it never touches the list.
  - A value set in the real environment still takes precedence.
- **Unchanged:** the authorization check itself (verified email AND on the allowlist), roles, permissions and schemas.

**Verified:**
- **Unit tests:** organization unit tests 20/20, including a new test that pins the `start` script's env files.
- **Integration suites:** organization and platform integration suites 42/42, on the test DB.
- **Live check:** run on the test DB, ports 3301/3302, with a mirror `.secrets/organization.env` written by the real script.

| Live check | Result |
|---|---|
| Organization process started with the real `start` flags reads the file | Startup log `organizationCreators: 2`, no addresses in the log |
| Allowlisted and verified account (stored in mixed case) | 201 |
| Allowlisted but unverified account | 403 `organization_creation_not_allowed`; 201 after verifying |
| Verified account not on the list | 403 `organization_creation_not_allowed` |

**Open:**
- `.secrets/organization.env` does not exist yet on this machine.
  - The person who owns the account runs `make organization-creators`, then `make organization-start`.
  - The listed account's email must be verified.

## Email delivery: Gmail SMTP with Nodemailer

- Date: 2026-11-03, 15:30–16:45 IST.
- Decision: [ADR 0014](decisions/0014-email-gmail-smtp.md), **Proposed**.
  - The product owner chose Gmail SMTP.
  - ADR 0012's architecture is kept; only the transport changes.

**Built:**
- **Kit (`src/email/`):**
  - `parseSmtpConfig` and `SmtpTransport` (Nodemailer `10.2.1`, pinned): STARTTLS required, TLS 1.2 or later, a pool of 2, finite timeouts, no file or URL access.
  - Safe error classification: a category, the SMTP reply code and a sanitized Nodemailer code. Never the server's reply text, recipients or content.
  - `BackgroundMailer`: requests never wait for SMTP, which closes the "forgot password" timing oracle.
    - Retries only where the message was certainly not accepted.
    - Bounded concurrency and queue.
    - Drained on shutdown.
  - `renderEmail`: a branded, responsive HTML layout with a plain-text twin. Every value is escaped; no remote images or tracking.
- **Identity:** `ACCOUNT_NOTIFIER=smtp`, with templates for:
  - email verification;
  - password reset;
  - password changed;
  - registration attempt.
- **Organization:** `INVITATION_NOTIFIER=smtp`, with an invitation template. Invitation resends use the same template, with the new token.
- **Both services:**
  - `WEB_APP_URL` must be https in production.
  - The failure log no longer contains error messages.
  - The `start` scripts read the gitignored `.secrets/smtp.env`.
  - A login check runs at startup and logs only `smtp_ready` or a category.
- **Credentials:** `make smtp-credentials` (a `read -s` hidden prompt in your terminal; mode 600; no echo, no command-line argument, no history), plus `make smtp-check` and `make smtp-test-email TO=…`.

**Not built:**

| Item | Why |
|---|---|
| OTP emails | No OTP feature exists to send them for (gap documented, not invented) |
| An invitation-accepted email | Not an existing flow |
| Bounce handling | Not built |
| A durable email outbox | Deferred to ADR 0007 |

**Results (lead, after the last code change):**

| Check | Result |
|---|---|
| `make ci-local` | exit 0. Suites: kit 131, identity 39, organization 19; all others unchanged (web 394, gateway 206, messaging 51, files 38, realtime 48, …) |
| `make db-test` | **877/877**, including new SMTP integration suites for identity (7) and organization (5) |
| Browser specs for sign-up, invitations, settings and sign-in | **9/9** |
| Mutation checks | Template escaping removed: 1 test fails. A 535 login refusal made retryable: 2 tests fail |

- **Integration tests:** all automated email tests use a local fake SMTP server or a capturing transport, and no real email was sent by them. They confirm that:
  - the links in emails verify the address and reset the password exactly once;
  - "forgot password" answers in under 500 ms while the transport is delayed by 2 s;
  - service logs contain no tokens or recipients.
- **Credentials:** `.secrets/smtp.env` was written at 16:13 by your own `make smtp-credentials` run. It is mode 600, inside the gitignored `.secrets/`, and has all the SMTP keys plus `ACCOUNT_NOTIFIER=smtp` and `INVITATION_NOTIFIER=smtp`. Its values were never displayed.
- **Gmail login (`make smtp-check`), 16:20: succeeded.** `smtp.gmail.com:587`, STARTTLS, as `smartconnectcollab@gmail.com`. No email was sent.
- **A real test email: not sent yet.** It needs a recipient address from you: `make smtp-test-email TO=<address>`.
- **Your running services:**
  - **Identity (:3101):** started at 11:43, before the file existed, so it still uses the dev mailbox. Restart it with `make identity-start` for real email.
  - **Organization (:3102):** restarted at 16:16. It loaded the file: invitation notifier `smtp`, and its Gmail login check succeeded.

## Platform mission: research, files, search, messaging collaboration, activity

- Started: 2026-11-03, about 12:30 IST.
- Last updated: 2026-11-03 15:25 IST. The mission is complete for the selected scope; blocked items are listed below.
- Safety:
  - No Git, no deploys, and no `.env`, Docker or Nginx changes.
  - No new npm dependencies.
  - No email delivery: ADR 0012's transport is unused.
  - Your gateway on :3000 and your dev services were not touched.

### Decisions recorded

- **[ADR 0013](decisions/0013-collaboration-platform-expansion.md), Proposed:**
  - **Federated search:** each service searches its own data as the caller; no index fed by events.
  - **Files service:** local storage driver behind an interface, plus a streaming gateway path. It deviates from ADR 0006's presigned URLs, because there are no service credentials.
  - **Activity:** derived inside messaging instead of a notifications service.
  - **Blocked, not faked:**
    - meetings with media (ADR 0005);
    - incoming webhooks and bots (they need service-to-service authentication);
    - the notifications service and relay (ADR 0002).
  - **Wave 2 contracts:** attachments, context, message search, activity, notification levels.
- **Event relay (ADR 0002):** not evaluated in practice. The spike needs a NATS server binary and an npm client, which are new dependencies that need your approval. Nothing in this mission depends on it.

### Competitor research (research subagent; official sources read 2026-11-03)

#### Access limits

- **Read successfully:** official pages for Slack (features, canvas, huddles, workflow automation; help articles on threads, search and notifications), Teams (the Learn pages: channels overview, security guide), Mattermost (platform, channels, docs, organize-conversations) and Rocket.Chat (docs, federation).
- **Failed:**
  - Discord's official support pages returned **403**, so Discord cells are unverified or community-sourced.
  - The Teams group-chat marketing page timed out.
  - The Rocket.Chat omnichannel page returned no content.
- **Caveat:** cells come from WebFetch summaries.

#### Matrix (condensed)

| Feature | Slack | Teams | Discord | Mattermost | Rocket.Chat | Strongest |
|---|---|---|---|---|---|---|
| Structure | Workspace (Enterprise: multi-workspace, unverified) | Teams contain channels, tied to the M365 directory; owner and member roles | Servers (unverified) | Teams contain channels; self-host | Workspace, channels, teams, discussions | Teams (hierarchy plus roles) |
| Channel types | Public and private; new members read history | Standard, private and shared, with a documented capability table; private channels lack bots and connectors | Not read (403) | Public and private | Channels and teams | Teams (explicit table) |
| Threads | Side panel, "also send to channel", Threads view, per-thread notifications | Not read | Auto-archive (community source only) | Collapsed reply threads, auto-follow when posting or mentioned, Threads view with an Unreads filter | Listed | Mattermost (follow model plus inbox) |
| Reactions and mentions | Activity view: mentions, reactions, replies | Team-wide mention settings | Not read | Mentions cause auto-follow | Federated | Parity |
| Files | Files tab in search | Stored in SharePoint | Not read | Previews; attribute-based access control on upload and download | Listed | Mattermost (policy) and Teams (governance) |
| Search | Modifiers (`in: from: has: before: after: during:`), phrases, exclusion, result tabs (Messages, Files, People, Channels), Ctrl/Cmd+F within a conversation | Not read | Not read | Semantic search through AI agents | Listed | Slack |
| Notifications | Per-channel exceptions, keywords, schedules, pause, a single Activity inbox | Not read | Not read | Per-followed-thread | Not read | Slack |
| Unread | Threads unread filter | Not read | Not read | Unread dot on threads, Unreads filter | Not read | Mattermost |
| Voice and video | Huddles: audio first, screen share, artifacts saved to the thread; free plan 2 people, 30 min | Meetings with lobby and roles; SRTP; E2EE calls | Not read | Calls with screen share and transcription | Jitsi, Meet and BigBlueButton integrations | Slack (one click, artifacts kept) |
| Scheduling | Not stated | Scheduled meetings in standard and shared channels | Not read | Not stated | Not stated | Teams |
| Docs | A canvas in every channel and DM | Tabs and Planner | Not read | Boards and Playbooks | Not stated | Slack canvas |
| Workflows | Workflow Builder: triggers, forms, branching, 70+ connectors | Not read | Not read | Playbooks with webhook triggers | Not stated | Slack |
| Integrations | 2,600+ apps; Slack Connect | Bots, connectors and tabs (standard channels only) | Not read | Plugins, webhooks, slash commands, bots | Marketplace, apps, API | Slack (breadth) and Mattermost (ChatOps) |
| Admin | Per-user controls | Owner, member and moderator roles; org overrides (up to 24 h to apply) | Not read | Role-based plus attribute-based access control | Role-based and attribute-based access control | Teams |
| Compliance | SOC 2/3, ISO 27001, FedRAMP Moderate, enterprise key management, DLP, legal hold | TLS and SRTP, encryption at rest, eDiscovery | Not read | Audit, DLP, burn-on-read, self-hosted or air-gapped | E2EE, SSO, audit, retention | Mattermost (control) and Slack/Teams (certifications) |
| Accessibility | Not covered | Not read | Not read | Not stated | Not stated | **Not assessed** |
| AI | Summaries, recaps, agent, AI search filters | Copilot (unverified) | Not read | Agents with a choice of model; RAG | Not stated | Mattermost (model choice) and Slack (shipped) |

#### Ten most valuable features for a company-only product (agent's ranking)

1. Threads.
2. Search with modifiers.
3. Layered notification scoping and an Activity inbox.
4. A public/private channel model with visible guardrails.
5. Admin roles, with the effective permission and its source shown.
6. Retention, eDiscovery and audit.
7. Files with previews, access checked at download time.
8. Huddles that keep their artifacts.
9. Docs next to chat.
10. No-code workflows.

#### Patterns worth adopting

- A reply side panel, with "also post to channel".
- A thread inbox with an unread filter, based on following threads.
- Search modifiers shown as removable chips, with result tabs.
- Three levels of notifications: global, per channel, keyword.
- Restrictions made visible per channel type.
- Changes to admin permissions applied immediately (Teams can take 24 h).

#### Pitfalls

From official sources:
- Teams' channel-type capability gaps are hard to discover.
- Slack keyword notifications only match exact words, and not in threads you don't follow.
- Rocket.Chat's federation may not carry permission changes.
- Mattermost's own scale claims are inconsistent.

### Wave 1 (implemented by three subagents; reviewed and verified by the lead)

| Module | What exists now |
|---|---|
| Messaging | Threads (reply panel, summaries, no replies to replies), reactions (one Unicode emoji, at most 20 distinct per message), mentions (`<@uuid>`, validated, kept in sync on edit), read cursors for channels plus unread counts, saved messages (visibility re-checked on every read), a safe Markdown subset (React elements only), a message actions menu. One shared store serves channels and direct and group conversations |
| Files | New service (:3106). Content type detected from magic bytes; size enforced while streaming; atomic staging; server-generated keys with path containment; `nosniff`, `CSP sandbox`, inline display for 4 image types only; uploader-only access until attachments exist. Gateway streaming path for exactly the two content routes. Files page in the web app with progress and retry |
| Search | `members?q=`, `workspaces?q=`, a new `GET /orgs/{o}/channels` (visible channels across workspaces; private channels only for their members, admins included); LIKE wildcards escaped; Ctrl/Cmd+K palette and search page; no search history kept |

**Lead verification of Wave 1, 13:00–13:05:**

| Check | Result |
|---|---|
| `make ci-local` | exit 0 |
| `make db-drift` | clean |
| `make db-test` | 765/765 |

`ci-local` suites: unit 14, kit 77, gateway 193, identity 26, organization 8, workspace 11, messaging 42, files 34, realtime 48, tokens 11, UI 8, web 338.

**Browser suite:**
1. **First run:** the stack did not start. The files service's browser-test port, 3306, is held by a MySQL server on this machine, so it moved to 3309.
2. **Re-run:** 22 passed and 7 failed:
   - 4 real accessibility regressions, all `label-content-name-mismatch` (WCAG 2.5.3) on new controls;
   - 2 specs for inline Edit and Delete buttons that the new actions menu deliberately replaced (test drift);
   - 1 retry spec, still under investigation.

   All seven are being fixed by the hardening agent.

**Wave 1 security review** (independent, read-only): no high-severity and no cross-tenant findings.

| Severity | Finding | Status |
|---|---|---|
| Medium | Encoded dot-segments (`%2e%2e`) could route around the dedicated file routes in the gateway | Being fixed (hardening agent) |
| Medium | Uploads have no pending-file cap, concurrency cap or cleanup | Being fixed (hardening agent) |
| Medium | A quadratic regex in the web formatter could freeze readers' tabs | Being fixed (hardening agent) |
| Low | A JSON `PUT` to file content hangs until 504; orphan object on commit failure; link-text spoofing | Being fixed (hardening agent) |
| Low | Reaction-cap race; saved-messages call amplification | Being fixed (messaging core agent) |

**Database, applied to dev after a backup each time:**

| Migration | Change | Backup |
|---|---|---|
| `files/20261103070501_add_upload_context_type` | Adds the enum value `upload` | `smartconnect-20261103T073012Z` |
| `messaging/20261103074338_wave2_attachments_activity_preferences` | Attachment snapshot columns, `conversation_preferences`, `activity_read_states` and `activity_item_reads`, each with RLS | `smartconnect-20261103T074600Z` |

Both migrations are additive. `db-drift` is clean, and `db-test` passed with them.

### Wave 2 (implemented by four subagents; reviewed and verified by the lead)

| Module | What exists now |
|---|---|
| Attachments | Posts take up to 10 of the sender's own `available` files. A metadata snapshot is stored, and a body may be empty when files are attached. Deleting the message removes the attachments. `GET /orgs/{o}/attachments/{fileId}` lets the files service authorize readers other than the uploader. The composer has upload chips with progress, retry and cancel. Image thumbnails and file cards use blob URLs fetched with the token |
| Message context | `…/messages/{id}/context` and the `?message=` parameter open a context panel around a search or activity result, with history from join enforced |
| Search | `GET /orgs/{o}/message-search`: full-text search over the caller's visible channels and conversations (scope enforced in SQL), attachment-name search, filters, and a cursor. The web search page turns `from:`, `in:`, `before:`, `after:` and `has:file` into chips |
| Activity | Mentions and thread replies, with visibility re-checked on every read. Unread state, mark-read and mark-all-read, an unread count capped at 100, a bell with a count, and an activity page with filters |
| Notification levels | `all`, `mentions` or `none` per channel or conversation. They hide items in activity; a muted icon shows in the conversation list |
| Hardening (Wave 1 findings) | Encoded dot-segments are refused (400) in every service. Raw-body routes are skipped by the JSON parser, and the upload stream answers 415 for anything but octet-stream. Pending and concurrent upload caps, server timeouts, a staging sweeper, and promote-after-commit. The formatter's quadratic regex is gone (URL cap, linear trailing-punctuation loop). Link display text is stripped of bidi characters and user info. Files `?q=`. The reaction-cap row lock and bookmark caps are in messaging |

**Full-text index.** The search agent measured, for a caller with 400 visible channels in a 250k-message database:

| Search | Without index | With index |
|---|---|---|
| Rare term | 1.2 s | 11 ms |
| Common term | 1.25 s | 328 ms |

So the lead added `messaging/20261103081229_message_body_fts_index`: a GIN index on `to_tsvector('simple', body)`.
- It is created in raw SQL. Prisma cannot model it, and the drift check stays clean.
- It was applied to dev after the backup `smartconnect-20261103T081325Z`.
- **Production:** it would need `CREATE INDEX CONCURRENTLY`, outside a transaction.

**Lead verification of the integrated Wave 2, 13:57–14:08:**

| Check | Result |
|---|---|
| `make ci-local` | exit 0 |
| `make db-drift` | clean |
| `make db-test` | 851/851 (38 files) |
| Full browser suite | 37/38. The one failure (search palette: Enter pressed while results were still settling, which the palette deliberately ignores) passed twice alone. The spec now waits for settled results |

`ci-local` suites: unit 14, kit 90, gateway 204, identity 26, organization 8, workspace 11, messaging 47, files 38, realtime 48, tokens 11, UI 8, web 394.

**Mutation checks (lead): each planted defect is caught.**

| Defect planted | Tests failed |
|---|---|
| Path-escape check disabled | 9 |
| Non-octet-stream uploads streamed | 1 |
| Attachment access: conversation check skipped | 1 |
| Attachment access: channel check skipped | 2 |
| Search channel scope dropped | 4 |
| Activity channel visibility dropped | 2 |
| The formatter's URL cap removed and the quadratic regex put back | 2 |

The messaging agent also confirmed that removing the reaction row lock fails its concurrency test.

**Wave 2 security review** (independent, read-only): no cross-tenant or private-content leak in the reviewed paths. Findings, being fixed with regression tests by the fix agent:

| Severity | Finding |
|---|---|
| Medium | The pending-upload cap can be exceeded by parallel creates |
| Low-medium | A delete racing an upload's promote leaves bytes on disk |
| Low-medium | Activity and saved messages can show excerpts of replies under deleted roots, or, in groups, under roots from before the join |
| Low | Attachment-access budgets can wrongly 404 and amplify calls |
| Low | A reaction can land on a just-deleted message |
| Low | A forged cursor may cause a 500 |
| Low | Expensive reads lack dedicated rate limits |

### Wave 3 (two subagents; reviewed and verified by the lead)

**Wave 2 review findings: all fixed.** Each regression test was shown to fail with its fix reverted.

| Finding | Fix |
|---|---|
| Pending-upload cap race | Advisory lock before counting. 40 parallel creates leave exactly the cap |
| Delete racing an upload's promote | The row is re-read after promote; a deleted file's key is removed (404) |
| Activity and saved showing replies under deleted or pre-join roots | The same root rules as replies, context and search |
| Attachment-access budgets | The visible-channels list is fetched once and the decision is one SQL query. A file in 25 channels, only the oldest visible, gives 200 with one workspace call |
| Reaction on a deleted message | The row lock now requires `deleted_at IS NULL`; tombstones show no reactions |
| Forged cursor | Milliseconds bounded to year 9999 (422) on history, search, activity and saved |
| Expensive reads | Gateway rate limits: message search 60/min, activity and unread count 120/min |
| Server timeouts | Added to identity, organization, workspace and messaging |

The realtime gateway was left alone: changing its timeouts is a behaviour change for you to decide.

**New browser specs:**
- attachments: composer upload with progress; live delivery with byte-exact download; image preview; private-channel 404; access lost after the message is deleted; direct conversation;
- message search: chips, the context panel, files results, private messages never found;
- activity: bell count, mark-read, mark-all-read, the Threads filter, notification level Off;
- accessibility (axe, light and dark) on the files, search, activity and saved pages and both side panels: no violations of any severity;
- 390×844 layout: no overflow, and the side panels are usable.

**One app bug found and fixed:** a stray second `setNotice` in `search-page.tsx` always showed "No single match for ." after a filter resolved. The spec is now a regression test.

**Test fixture change:** the e2e founder allowlist grew from 40 to 100, because the suite now creates more organizations.

### Final verification (lead, after the last code change)

Run 14:56–15:18 IST on a quiet machine, after every agent had finished.

| Check | Result |
|---|---|
| `make ci-local` | **exit 0** |
| `make db-drift` | **clean** |
| `make db-test` | **865/865**, exit 0 (39 files) |
| `make e2e` (Playwright, the local Chrome) | **51/52** in 16.9 min |

`ci-local` suites: unit 14, kit 90, gateway 206, identity 26, organization 8, workspace 11, messaging 51, files 38, realtime 48, tokens 11, UI 8, web 394. The audit's only findings are the 11 known moderate minimatch advisories.

**The one browser failure, and the change it led to:**
- The phone-width test visits about 15 pages in one test. Its default 60 s budget ran out while a page still showed "Loading organization…", with the machine's load average around 10 during the run.
- It got an explicit 180 s budget; the per-check timeouts are unchanged.
- `responsive.spec.ts` then passed **4/4** (both of its tests, twice; 22–23 s each).
- This was a test-only change made after the full run. The full 52-test suite was not re-run afterwards.

**Measured realtime latency, no reload, in the loaded final run:**

| Delivery | Latency |
|---|---|
| Channel | 260–839 ms |
| DM | 1.1–1.3 s |
| Group | 0.98 s |

Earlier, quieter runs measured 120–431 ms.

**Ports and processes:**
- Test ports 3300–3305, 3309 and 5174 were free afterwards.
- Your gateway on :3000 (pid 82223) and your identity service on :3101 were never touched.

### Features selected, and why (against the research)

| Research priority | Built | Why it was selected, or why not |
|---|---|---|
| 1. Threads | Yes: side panel, summaries, Threads filter in activity | Top value for keeping channels readable |
| 2. Search with modifiers | Yes: federated, scope enforced in SQL, chips, jump to context, full-text index | High value. No new infrastructure needed (PostgreSQL full-text search) |
| 3. Layered notifications and an Activity inbox | Partly: an activity inbox, plus notification levels per conversation | Keyword alerts, schedules and push or email delivery are not built. Delivery needs the relay (ADR 0002), and email is deferred (ADR 0012) |
| 4. Visible channel guardrails | Already present (public and private), unchanged | Existing model |
| 5. Admin roles with effective permissions | Existing roles, unchanged | Not in this mission's selected scope |
| 6. Retention, eDiscovery, audit | No | Needs a compliance-access policy decision (open since Sprint 2) |
| 7. Files with previews, checked at download time | Yes: files service, attachments, previews for 4 image types, authorization on every download | High value. A local driver now; object storage (ADR 0006) later |
| 8. Huddles and meetings | No: **blocked** | No media server. ADR 0005 (LiveKit) needs a budget decision, and a UI without media would be fake |
| 9. Docs next to chat | No | Out of scope (a large product area; the `documents` schema exists) |
| 10. Workflows and integrations | No: **blocked** | Incoming webhooks and bots need service-to-service authentication. Running arbitrary steps needs a security design |

Also built: reactions, mentions, unread markers, saved messages, safe formatting, the message actions menu.

### Agents in this mission

| Agent | Delivered | Lead verification |
|---|---|---|
| Research | Comparison matrix from official sources (Discord's pages refused access) | Condensed into this report |
| Messaging (Wave 1) | Threads, reactions, mentions, read state, saved messages, formatter, menu | Code review, full suites |
| Files (Wave 1) | Files service, streaming gateway path, Files page | Review of the streaming proxy and bypass; lockfile check (no new packages) |
| Search (Wave 1) | Member, workspace and channel search; palette | Review of the visibility query |
| Security reviewers (×2) | Wave 1: 3 medium and 5 low findings. Wave 2: 1 medium and several low, no leaks | All findings fixed and tested |
| Messaging core (Wave 2) | Attachments, context, caps | Mutation checks |
| Search (Wave 2) | Message and file search, chips, index measurement | Mutation checks; the lead added the index |
| Activity (Wave 2) | Activity center and notification levels | Mutation checks |
| Hardening (Wave 2) | Wave 1 findings, browser failures, 9 new browser specs | Mutation checks |
| Fix (Wave 3) | Wave 2 findings | Its fails-without-fix evidence; final suites |
| Browser QA (Wave 3) | 14 new browser tests plus accessibility and responsive coverage | Final full run |

### Known limitations (this mission)

- **Blocked:**
  - meetings with media (ADR 0005);
  - incoming webhooks, bots and workflows (service-to-service authentication);
  - a notifications service with push or email delivery (ADR 0002 relay; ADR 0012 email deferred to deployment).
- **Realtime:** channel mentions are not pushed, because that would reveal private channels. Activity polls every 30–60 s and refetches on existing events.
- **Files:**
  - Storage: a local disk driver only, with no object storage.
  - Not built: malware scanning (the `scanning` status is unused), thumbnails or renditions, per-organization storage quotas.
  - Stale pending uploads are retired per organization when someone in it next uploads; there is no cross-tenant sweep.
- **Search:**
  - No relevance ranking: results are newest first.
  - No trigram index for name searches.
  - People with more than 10,000 visible channels would get 503.
  - The full-text index creation in production needs `CREATE INDEX CONCURRENTLY`.
- **Messaging:**
  - Not built: edit history, pins, forwarding, server-side link previews, `@channel` and `@here`.
  - Thread replies don't update a conversation's last activity.
  - A file-only message can only be edited by adding text.
- **Per-instance limits:** some limits are kept in each instance's memory (upload concurrency, socket caps).
- **Performance:**
  - Each request still makes cross-service authorization calls, with no caching.
  - Search and activity fetch the caller's visible channels on every request.

### Decisions required from you

1. Approve or amend **ADR 0013** (this mission's architecture) and **ADR 0012** (email via Resend, deferred).
2. Earlier decisions still open: ADR 0004, 0010 and 0011; the ADR 0002 spike; a compliance-access policy.
3. **Service-to-service authentication** (needed for incoming webhooks, bots and a notifications service) and the **event relay** (ADR 0002).
4. **ADR 0005** (meetings media: LiveKit Cloud or self-hosted, and budget).
5. Realtime gateway server timeouts (optional hardening).

### Next steps (recommended)

1. The decisions above; then the ADR 0002 spike, an outbox relay and a notifications service, with delivery. That unlocks the cross-service notifications (invitations, membership) that activity cannot cover.
2. Object storage (ADR 0006) with malware scanning and thumbnails.
3. Meetings, once ADR 0005 is decided.

## Sprint 2: architecture review, frontend completion and browser QA, direct and group messaging

- Started: 2026-11-03, with the first file change at 10:31 IST.
- Last updated: 2026-11-03 11:55 IST.
- Safety:
  - No Git, no deploys, no `.env`, Docker or Nginx changes, and no destructive database operations.
  - Your gateway on :3000 was left untouched.

### Status

| Phase | Work | Status |
|---|---|---|
| 1 | Architecture review of ADRs 0002, 0004 and 0010 | **Done.** Recommendations are below. Nothing was approved on your behalf, and nothing new was introduced (no NATS) |
| 2 | Missing screens: departments, teams, workspace settings, organization settings, sessions, password change | **Done.** Verified by unit tests and in a real browser |
| 2 | Real-browser QA (Playwright, local Chrome) | **Done:** 29/29 specs in real Chrome (final run) |
| 3 | Direct conversations | **Done**, backend and frontend |
| 4 | Group conversations | **Done**, backend and frontend |
| 5 | QA and security | **Done.** Full suites, an independent review (medium finding fixed), mutation checks and browser runs |

New decision record: [ADR 0011](decisions/0011-direct-and-group-conversations.md), direct and group conversations. It is **Proposed** and needs your approval.

**Who built what:**
- **Lead:**
  - the design (ADR 0011 and the API contract);
  - the realtime gateway inbox;
  - organization-service member lookup and API-gateway routes;
  - the Playwright harness (`make e2e`);
  - the dev-DB migration;
  - the security fixes (stale participants, inbox via messaging, the accessibility label fix);
  - the Redis-to-socket integration tests;
  - every final run and mutation check;
  - this report.
- **Subagents:**
  - the messaging conversations backend;
  - the settings and account screens;
  - the conversations UI;
  - the browser specs;
  - one independent read-only security review.

  The lead reviewed their code and re-ran their tests.

### Phase 1: architecture review

**[ADR 0004](decisions/0004-realtime-gateway.md), realtime gateway: Proposed, and built as an interim design.**
- **What was built differs from the ADR text:**
  - The ADR says membership is cached in Redis and invalidated by events, that events arrive from the broker, and that clients resync by sequence number.
  - What runs is this:
    - Each subscription is authorized by asking the owning service as the user: workspace for channels, messaging for conversation inboxes.
    - Joined rooms are re-checked every 60 s.
    - Events are best-effort Redis pub/sub after commit.
    - Clients refetch on every (re)subscription.
  - Several gateway instances already work without the Socket.IO Redis adapter, because every instance subscribes to Redis and emits only to its own sockets.
- **Trade-offs:**
  - **For:** authorization is always the owner's current answer, with no cached membership to go stale. It is simple and stateless.
  - **Against:** every subscribe and re-check costs a call chain (gateway → workspace → organization). Revocation is delayed by up to the re-check interval, and nothing is replayed.
  - **Estimate:** at the target 1,500 users with about 10 rooms each, re-checks are about 250 calls/s into the workspace service, each with one organization call behind it. This is an estimate, not a measurement.
- **Security:**
  - Events carry ids only, and REST authorizes the content again.
  - It fails closed, checks origins, and closes the socket when the token expires.
  - There are per-user socket caps, a per-socket room cap and subscribe rate limits.
  - Conversation recipients are computed by messaging at commit time, so removing someone from a group cuts them off at once.
- **Recommendation:** **amend, then approve.**
  - Record the interim design (owner-service authorization per subscribe plus periodic re-check, Redis pub/sub as best-effort transport until ADR 0002, inbox rooms from ADR 0011).
  - Record the conditions for revisiting it: a load test, membership caching, and a broker.

**[ADR 0010](decisions/0010-organizations-and-membership.md), organizations and membership: Proposed, implemented and tested.**
- **Trade-offs:**
  - **Allowlist:** organization creation through an allowlist is safe (fail closed) but awkward to operate.
  - **Synchronous authorization:** every request checks with the caller's own token. That means no confused deputy and immediate revocation, but it costs latency and couples availability: if the organization service is down, every tenant request answers 503.
  - **Stale projections:** they persist until an event relay exists.
- **Security implications:**
  - Admins and owners cannot read private channels, teams or conversations. That honours the product rule, but it also means **no compliance or eDiscovery access exists**.
  - Any such access needs an explicit, documented policy (an open decision).
- **Recommendation:** **approve as implemented.** Track these as separate decisions:
  - a platform-administrator concept to replace the allowlist;
  - guests;
  - membership caching (TTL);
  - a compliance-access policy.

**[ADR 0002](decisions/0002-event-broker-nats-jetstream.md), event broker (NATS JetStream): Proposed, not implemented, and not introduced in this sprint.**
- **Why it matters now:**
  - The outbox tables fill and are never published or pruned.
  - Member names in projections go stale.
  - People removed from the organization keep inert workspace, channel and conversation rows until their next request. This sprint mitigates that for conversations, but it is not fixed.
  - Search and notifications both need durable events.
- **Recommendation:**
  - Approve only the **2-day spike** the ADR describes: measure the footprint, and test dedupe plus redelivery with the outbox tables.
  - Decide on adoption after the spike.
  - Until then, an outbox retention job is needed.

**Decisions waiting for you:**
1. ADR 0004: amend and approve (above).
2. ADR 0010: approve.
3. ADR 0011: approve or amend. Its choices are history from join, admin-managed groups, any participant may leave, and per-organization inbox rooms.
4. ADR 0002: approve the spike.
5. A compliance-access policy for private content (currently none).

### Built and verified (this sprint)

- **Direct and group conversations** (messaging service, [ADR 0011](decisions/0011-direct-and-group-conversations.md), [contract](api/endpoints.md)):
  - **Participants only:** everyone else gets 404, organization owners included. Every request checks organization membership with the caller's token and fails closed.
  - **Direct conversations:**
    - one per pair, find-or-create safe under concurrency;
    - no conversation with yourself;
    - `409 participant_inactive` once the other person has left the organization.
  - **Groups:**
    - 3–50 people;
    - admins add, remove, rename and change roles, under a row lock;
    - anyone can leave, and the longest-standing member becomes admin when the last admin leaves;
    - demoting the last admin is refused.
  - **History starts at each person's join:** this holds for listing, editing, deleting, read cursors and unread counts.
  - **Ordering and unread:**
    - the list is ordered by last activity, with a cursor;
    - read cursors only move forward;
    - unread counts are capped at 100 and computed in one SQL statement per page.
  - **Messages:** posting is idempotent; only the sender edits; the sender, or a group admin, deletes, and deletion erases the body.
  - **Events:** outbox events and realtime events carry ids only.
- **Removed and re-invited people:**
  - Their own leftover rows are dropped on their first request.
  - Since the security review, their rows are also treated as absent when someone adds them, DMs them or posts to their DM, and before their realtime inbox is joined.
- **Realtime inbox** (realtime gateway):
  - A socket joins only its own inbox (`inbox:{org}:{user}`, keyed from the token), after messaging confirms it.
  - Events go only to the recipients messaging named, and the recipient list never reaches clients.
  - Losing organization membership evicts the inbox at the next re-check.
  - Event parsing is strict.
- **API gateway:**
  - `/orgs/{o}/conversations[/*]` routes to messaging;
  - posting a message is rate-limited like channel posts.
- **Organization service:** member lookup by up to 100 repeated `userId`s; only active members are returned.
- **Web app:**
  - **Settings and account screens:**
    - department edit and delete, with cycle and not-empty errors;
    - team edit and delete;
    - workspace settings (admins only);
    - organization settings (`organization.update`; read-only for others);
    - account sessions (end one, sign out other devices, sign out everywhere);
    - password change.
  - **Direct messages:**
    - conversation list with unread badges (`99+`);
    - new DM and new group dialogs with a searchable member picker;
    - the conversation view reuses the channel message thread;
    - mark-as-read while visible;
    - a group details panel (rename, add, remove, promote and demote, leave);
    - "not available" and "former member" states.
  - **Live updates:** through the inbox, with backoff and resubscribe; polling every 5 s or 30 s when not live.
  - **Motion:** subtle, respecting reduced motion.
- **Accessibility fix** (found by the browser suite): the sidebar switchers and the "Make admin" button had accessible names that did not contain their visible text (WCAG 2.5.3). They are fixed, and the browser suite now checks this on every page with no exclusions.
- **Browser test harness** (`make e2e`, [tests/e2e/README.md](../tests/e2e/README.md)):
  - Playwright 1.64.1 drives the local Chrome against the whole stack on its own ports (3300–3305, 5174) and the test database.
  - **Dependency:** one dev dependency, `@playwright/test@1.64.1` (Apache-2.0), with 3 packages added to the lockfile. The pre-change lockfile was backed up outside the repo.
  - **Vite proxy:** its targets can now be overridden (`WEB_DEV_API_TARGET`, `WEB_DEV_REALTIME_TARGET`). The defaults are unchanged.

### Database

**Migration `messaging/20261103050523_conversation_roles`** is additive. It adds `CREATE TYPE "ConversationRole"` and `conversation_members.role` (`NOT NULL DEFAULT 'member'`).

| Step | Result |
|---|---|
| Dev database backed up first | `infrastructure/backup/output/smartconnect-20261103T052124Z` |
| Applied to the local dev DB | `make db-migrate` |
| Status | `make db-status`: messaging up to date |
| Drift check | `make db-drift`: clean |
| Migrations from zero | Covered by `make db-test` |

No other schema changed.

### Tests (lead, final runs after the last code change)

**`make ci-local`: exit 0.** Prettier, ESLint (zero warnings), Prisma validation and generation, typecheck, build and audit all pass. Test counts:

| Suite | Passed | Night sprint |
|---|---|---|
| unit | 14 | 14 |
| kit | 16 | 16 |
| gateway | 163 | 157 |
| identity | 26 | 26 |
| organization | 8 | 8 |
| workspace | 11 | 11 |
| messaging | 20 | 18 |
| realtime | 48 | 36 |
| tokens | 11 | 11 |
| UI | 8 | 8 |
| web | 237 | 172 |

The audit's only findings are the same 11 known moderate minimatch advisories in the ESLint toolchain.

**`make db-test`: 652/652, exit 0** (24 files, fresh test instance):

| Suite | Passed |
|---|---|
| Pre-existing database, privilege and RLS suites | 393 |
| Identity integration, plus the gateway in front of identity | 75 |
| Organization integration (+1: multi-user lookup) | 30 |
| Workspace integration | 43 |
| Messaging: channel messages | 43 |
| Messaging: direct and group conversations (new) | 47 |
| Realtime, channel events: messaging → Redis → gateway → socket | 5 |
| Realtime, conversation events: messaging → Redis → gateway → inboxes (new) | 5 |
| Platform end-to-end through the gateway | 6 |
| Redis rate-limit store | 5 |

`make db-drift`: clean.

**Mutation checks (lead): every planted defect was caught by the tests.**

| Area | Defect planted | Tests failed |
|---|---|---|
| Messaging | History-from-join filter removed | 4 |
| Messaging | Stale memberships kept on re-invite | 2 |
| Messaging | Group admin check skipped | 1 |
| Messaging | Removed person not notified | 1 |
| Messaging | Participation ignoring the caller (an IDOR) | 13 |
| Messaging | Leftovers kept when an admin re-adds someone | 1 |
| Messaging | Leftovers kept on a DM post | 1 |
| Realtime | Broadcast to every inbox instead of the named recipients | 5 |
| Realtime | Inbox re-check skipped | 2 |
| Web | Inbox events ignored | 2 |
| Web | Mark-as-read skipped | 2 |

### Browser verification (Playwright, real Google Chrome 156, final run by the lead)

**Full Playwright suite: 29/29 passed in 5.6 min** (final full run at 11:46 IST, after the last change), plus 5/5 repeats of the inline-retry spec.
- The command was `npx playwright test --config e2e/playwright.config.ts`. That is `make e2e` without its rebuild: the services were built by the 11:28 `make e2e` run and have not changed since.

How it got there:
- **First browser verification:** this is the project's first real-browser verification; the night sprint had none.
- **First issue:** a full run at 11:28 had 28/29. The inline message-history retry spec failed on a race in the test: a background refetch recovered the page between the stub switching to success and the click. The spec now waits for those refetches first.
- **Second, rarer issue:** a repeated run (one in three) found the click itself intercepted by `<html>`. The button had moved between Playwright's hit test and the click. The spec now dispatches the click on the button and checks it is visible first.
- **Open question:** whether that momentary shift can affect real users is not proven either way. It is listed under limitations.

**Measured in the final run (no reload):**
- realtime latency: channel messages 120–315 ms, DMs 148–251 ms, a group message 363 ms;
- the reader's websocket was open and received frames.

**Ports:** 3300–3305 and 5174 were free after every run. :3000 was never touched by these runs.

What the specs verify (written by a subagent; the lead re-ran the whole suite):
- **Authentication:** registration, email verification by link, sign-in errors, sign-out, and redirect back after sign-in.
- **Invitations:** a wrong account is refused, and the right account lands in the organization.
- **Organizations and workspaces:** switching organizations, creating and navigating workspaces and channels.
- **Departments and teams:** CRUD; private teams are hidden.
- **Channels:** a private channel by URL shows "not found", with no content.
- **Channel messaging:** post, edit, delete and live delivery.
- **Settings:** organization and workspace settings, sessions, and password change (other sessions are ended).
- **Direct messages and groups:**
  - live appearance, unread badges, and live delivery both ways;
  - the full group admin flow, including `last_admin`;
  - a removed person's view switches to "not available";
  - a non-participant or guessed URL shows nothing;
  - `participant_inactive`.
- **Layout and accessibility:**
  - at 390×844, no horizontal overflow on 15 pages;
  - axe-core on 19 pages and 2 overlays in light and dark themes;
  - the theme menu persists.
- **States:** loading, error and retry.

**Measured realtime latency (no reload):**
- channel messages 119–431 ms;
- DMs 117–269 ms;
- groups 271–554 ms;

across the subagent's runs.

### Security review (independent, read-only subagent)

There were no critical or high findings, and no route, socket event or event payload lets a non-participant, an owner or admin, or another organization read content.

| Severity | Finding | Outcome |
|---|---|---|
| Medium | A removed and re-invited person's old participant rows lingered until their first request: an admin re-adding them got a silent no-op, ghost rows counted towards caps and admins, and a new inbox socket could get id-only events of old conversations | **Fixed.** Rows are treated as absent when someone adds them, DMs them or posts to their DM (using the membership start from the organization service), and inbox authorization moved to messaging, which prunes first. Regression tests are mutation-checked |
| Low | User ids from the token were not lower-cased, so an upper-case `sub` could create a second DM per pair | **Fixed:** the conversation routes lower-case the caller's id |
| Low | Security-relevant time comparisons use application clocks of different services | Accepted: the services are NTP-synced. Moving `joinedAt`, `createdAt` and `lastMessageAt` to database time is recommended |
| Low | Unread counting scans deleted messages: a participant who posts and deletes very many messages slows others' list queries | Accepted: posting is rate-limited. A partial index excluding deleted rows is recommended |
| Low | RLS isolates organizations, not participation | Accepted: defence in depth. Participant-based policies are possible later |

### Known limitations

- **No event relay** (ADR 0002). Removed members' rows stay inert until their next request, or until they are re-added (conversations).
  - **Last admin removed from the organization:** if a group's only admin is removed from the organization, the group has no working admin until a relay can clean up. Participants can still talk and leave.
  - **Outbox growth:** outbox rows are never published or pruned.
- **Realtime:**
  - Delivery is best effort, with no replay.
  - Losing organization membership ends inbox and channel subscriptions at the next re-check (60 s by default). Removal from a group is immediate.
- **Conversations:**
  - No system messages: joins and leaves are not shown in the timeline.
  - No threads, reactions, mentions, attachments, typing or presence.
  - An admin-less group is possible only through organization removal.
  - Messages are ordered by an application-clock timestamp; there is no per-conversation sequence number (G-10).
- **Member picker:** it loads the whole member directory and filters it in the browser; there is no server-side search.
- **Open UI question:** in one of three runs of the inline "Try again" spec, a re-render moved the message history's button between hit test and click. Whether real users can hit this is unverified.
- **Your gateway on :3000:** it is now a process restarted at 11:46 from your VS Code terminal (`make gateway-start`, pid 82223). None of this sprint's runs started, stopped or used it.
- **No membership caching:** each conversation request makes one organization call, plus one when posting to a DM.
- **Not started:** files, search, notifications, meetings.

### Run locally

```bash
make infra-up && make db-migrate && make prisma-generate && make auth-dev-keys   # once
make identity-start                                                              # :3101
ORGANIZATION_CREATOR_EMAILS=you@example.com make organization-start              # :3102
make workspace-start                                                             # :3103
REDIS_URL='redis://:<REDIS_PASSWORD from .env>@127.0.0.1:6379/0' make messaging-start   # :3104 (asks :3103 and :3102)
REDIS_URL='redis://:<REDIS_PASSWORD from .env>@127.0.0.1:6379/0' make realtime-start    # :3105 (asks :3103 and :3104)
make gateway-start      # :3000 (restart your old gateway first: it predates the conversation routes)
make web-dev            # http://127.0.0.1:5173
make e2e                # browser tests on their own ports and the test DB (not with make db-test at the same time)
```

### Next action

1. **Decisions for you:** ADR 0004 (amend and approve), ADR 0010 (approve), ADR 0011 (approve or amend), the ADR 0002 spike, and a compliance-access policy.
2. **Recommended next task:**
   - the ADR 0002 spike, plus an outbox relay and retention;
   - this unblocks cleanup on member removal, fresh member projections, notifications and search;
   - then threads, reactions and read receipts on the existing schema.

---

## Night sprint (previous): organizations, workspaces, channels, channel messaging, realtime

- Sprint start: 2026-11-03 01:28 IST
- Last updated: 2026-11-03 02:55 IST
- This is the single progress report for the sprint. It records facts only: something counts as done only when tests verify it.
- Correction: an earlier version said "Last updated 05:20". That time was wrong; the clock and file times show 02:20.

### Verified starting state (01:28)

- **Repository:** no Git (none was initialised, by instruction).
- **Running:**
  - Docker: PostgreSQL :15432, test PostgreSQL :15433 and Redis :6379, all healthy.
  - Homebrew PostgreSQL :5432 (untouched).
  - A gateway on :3000 that you started from a VS Code terminal. It was left running and is still untouched. It runs the Task 2 build.
- **Baseline `make ci-local`: exit 0.**

  | Suite | Passed |
  |---|---|
  | unit | 14 |
  | kit | 16 |
  | gateway | 139 |
  | identity | 25 |
  | tokens | 11 |
  | UI | 6 |
  | web | 32 |

- **Baseline `make db-test`:** 466/466.

### Status

| # | Work | Status |
|---|---|---|
| 1 | Organizations and workspaces | **Done:** backend and frontend |
| 2 | Departments, teams, membership and roles | **Done:** backend and frontend |
| 3 | Invitations and onboarding, including identity email verification | **Done:** backend and frontend |
| 4 | Channels (public/private, membership, join/leave) | **Done:** backend and frontend |
| 5 | Core messaging (channel messages), realtime delivery and reconnect recovery | **Done:** backend verified by integration tests and live; realtime gateway verified live, including access revocation; the frontend receives live updates |
| 6 | Frontend integration | **Done** for 1–5, including member management and live updates. Some edit screens are missing (see limitations) |
| 7 | QA and security | **Done for what exists:** full suites, independent reviews (findings fixed), live verification. See below |

The realtime gateway implements [ADR 0004](decisions/0004-realtime-gateway.md), which is still **Proposed**. It was built because the sprint asked for realtime "where safely achievable"; it needs your approval.

Who built what:
- **Lead:**
  - organization service, identity changes, gateway, kit, migration;
  - the realtime channel cap;
  - frontend realtime integration;
  - all documentation and verification.
- **Subagents:** the workspace service, messaging service, realtime gateway and frontend. The lead reviewed them and re-ran their tests.
- **Independent read-only reviewers:** two security reviews, one of the platform and one of the realtime path.

### Built and verified

- **Identity:**
  - `GET /auth/me`, which refuses suspended accounts.
  - Email verification: registration sends a link; `POST /auth/email/verify` and `POST /auth/email/verification` (resend).
  - A completed password reset also verifies the email.
  - Email links put tokens in the URL fragment, never in the query string.
- **Organization service (:3102):**
  - organization creation, limited to verified emails on the allowlist and failing closed;
  - profile and settings;
  - roles and the permission catalogue;
  - members, with owner protections under a row lock;
  - invitations: create, list, resend, revoke, public preview, accept. Acceptance needs the verified invited email, is single-use, re-checks the inviter's authority and binds to the token hash;
  - departments (nested, no cycles);
  - teams: private teams are visible to their members only, management rights included, and the creator becomes lead.
- **Workspace service (:3103):**
  - open and private workspaces, with join/leave and members;
  - public and private channels: private ones are hidden even from admins and owners;
  - last-admin rules;
  - organization membership checked per request, using the caller's own token and failing closed;
  - stale memberships pruned when someone is re-invited.
- **Messaging service (:3104):**
  - channel history, newest first with a cursor;
  - posting, with idempotent retries via `clientMessageId`;
  - editing by the sender only;
  - deletion by the sender or a channel admin, which erases the body;
  - visibility asked of the workspace service per request;
  - outbox events (ids only), and after commit an id-only realtime publish to Redis (best effort).
- **Realtime gateway (:3105, Socket.IO, stateless):**
  - Authentication: an access token is required in the handshake, and the socket closes when the token expires. Browser origins are checked against an allow-list.
  - Subscribing to a channel asks the workspace service as the user. Anything other than a clean, matching 200 refuses the subscription.
  - Joined rooms are re-checked every 60 s (configurable). Losing access removes the socket from the room and emits `unsubscribed`.
  - Events are id-only, and clients refetch through REST.
  - Limits: 30 subscribe attempts per minute, `MAX_CHANNELS_PER_SOCKET` rooms (default 200), `MAX_SOCKETS_PER_USER` sockets (default 10) and 4 KiB payloads.
  - [README](../smartconnect-backend/realtime-gateway/README.md).
- **Gateway:**
  - routes in order: auth, then messages, then workspaces, then organizations;
  - invitation preview public, everything else protected;
  - per-IP and per-user rate limits.
- **Frontend (subagent; realtime by the lead):**
  - Channel conversation view: history paging, an idempotent composer with retry, edit and delete with tombstones, a join call to action, and an archived state. Bodies render as plain text (no `innerHTML`). There are no fake typing indicators.
  - **Live updates:**
    - One Socket.IO connection, opened only while a channel is open.
    - An event, or any (re)subscription, refetches the channel, which recovers events missed while disconnected.
    - After a server-side disconnect (token expiry), the client refreshes and reconnects with backoff, and sign-out closes the socket.
    - A subscription the gateway could not check, or evicted, is retried with backoff; `not_found` is final.
    - Polling drops to every 60 s while live and returns to every 5 s otherwise.
    - The Vite dev server proxies `/realtime` (WebSocket) to :3105.
  - Workspace and channel member management.
  - API client: the access token is held in memory only; refresh is single-flight across tabs.
  - Pages for auth, email verification, password reset, organizations, invitations (admin view and acceptance), members, departments, teams, workspaces and channels.
  - Motion transitions with reduced-motion support.
- **Decisions:** [ADR 0010](decisions/0010-organizations-and-membership.md) (Proposed).
- **Contract:** [api/endpoints.md](api/endpoints.md).

### Database

**Migration `organization/20261102200911_departments_teams`** is additive and forward-only:
- adds `organizations.description` and `organizations.settings`, with a CHECK that `settings` is a JSON object;
- adds the member projection columns `display_name` and `email`;
- adds the `departments`, `teams` and `team_members` tables, with composite tenant FKs, RLS and a CHECK that a department is not its own parent.

| Step | Result |
|---|---|
| Dev database backed up first | `infrastructure/backup/output/smartconnect-20261102T200932Z` |
| Applied to the local dev DB | `make db-migrate` |
| Drift check | `make db-drift`: all 14 services clean |
| Migrations from zero | Covered by `make db-test` |

No other schema changed. The realtime gateway has no database.

### Tests (executed by the lead, final runs)

**`make ci-local`: exit 0.** Prettier, ESLint (zero warnings), typecheck, build and audit all pass. Tests:

| Suite | Passed |
|---|---|
| unit | 14 |
| kit | 16 |
| gateway | 157 |
| identity | 26 |
| organization | 8 |
| workspace | 11 |
| messaging | 18 |
| realtime | 36 |
| tokens | 11 |
| UI | 8 |
| web | 172 (161 plus 11 realtime tests) |

The audit's only findings are the 11 known moderate minimatch advisories in the ESLint toolchain.

**`make db-test`: 599/599, exit 0** (22 files), on a fresh test instance:

| Suite | Passed |
|---|---|
| Pre-existing database, privilege and RLS suites | 393 |
| Identity integration | 67 |
| Gateway in front of the real identity service | 8 |
| Organization integration | 29 |
| Workspace integration | 43 |
| Messaging integration | 43 |
| Realtime: messaging → Redis → gateway → socket | 5 |
| Platform end-to-end through the gateway | 6 |
| Redis rate-limit store | 5 |

This run came after the last code change: the realtime review fixes.

One test was flaky during the sprint: the concurrent owner-demotion race asserted a single status, although 403 and 409 are both correct. It was fixed, and the suite passed three runs in a row before the final runs.

**Mutation checks:**
- identity and organization guards: every mutation was caught;
- web realtime: each of these fails the tests:
  - ignoring change events;
  - skipping the resubscription on connect;
  - dropping the retry after `unavailable`;
  - resetting the backoff on connect.
- realtime gateway: removing the per-user socket cap fails its test.

### Live verification (lead, final run 02:52, after the review fixes)

**Setup:** six processes built from current sources, against the test database and the local Redis:
- gateway :3300 (started with the real `make gateway-start`), identity :3301, organization :3302, workspace :3303, messaging :3304 and realtime :3305;
- the Vite dev server on :5173.

The user's :3000 was untouched, and every process the lead started was stopped afterwards.

**REST, 21 checks, all as required:**
- **Onboarding:** registration and email verification; organization creation refused for a non-allowlisted user (403); invitation preview, wrong-email acceptance (403), acceptance, and replay (404).
- **Isolation:**
  - private workspaces;
  - private channels, including against the owner;
  - private channel messages: read, post, edit and delete by a non-member all give 404;
  - an outsider gets 404;
  - removing someone from the organization cuts their message access immediately.

**Realtime, 11 checks, all as required.** They were run twice: directly, and through the real Vite proxy with a browser `Origin`.
- A socket without a token is refused, and so is a foreign `Origin`.
- An owner subscribes to a private channel they belong to; a non-member gets `not_found`.
- Posting emits `created`, and deleting emits `deleted`. Events carry ids only (`channelId`, `messageId`, `organizationId`, `type`, `workspaceId`), with no body.
- The non-member's socket received nothing.
- Guessed ids give `not_found`: a random channel, or a private channel under the wrong workspace. Garbage gives `invalid`.
- **Revocation:** after removal from the organization, the person's live subscription to a public channel ended with `unsubscribed` within 2.8–4.8 s across runs (the re-check interval was 5 s for these runs), and no later events reached them.

**Logs:** no message bodies or passwords in any service log, including realtime and Vite.

### Security reviews (independent, read-only subagents)

**Platform review: no critical findings.** Every finding was fixed with regression tests:

| Severity | Finding |
|---|---|
| High | Holders of `teams.manage` could see and join any private team |
| Medium | A re-invited person regained old private workspace and channel memberships |
| Medium | Adding a team member could race a member removal and leave an orphan team membership |
| Low–medium | The inviter's authority was not re-checked at acceptance |
| Low | The token hash was not bound inside the acceptance transaction |
| Low | `/auth/me` answered for suspended accounts |

Accepted as low or left open (documented):
- A row lock is taken before the visibility check in the workspace service: a weak timing signal; responses are still 404.
- The department-move cycle check has no lock: an integrity issue, not an access one.
- The outbox tables have no RLS: by design, for the relay.

**Realtime review (gateway, publisher and web client):** no critical or high findings, and no authorization bypass.

The reviewer traced these end to end:
- Access decision: as the user, with an exact id match.
- Room keys: one per channel UUID, with ids validated and lowercased.
- No existence oracle: 403 and 404 both give `not_found`.
- Events: id-only and strictly parsed.
- Token: in memory only, and never logged.
- Sign-out: closes the socket.

Fixed, each with a regression test that fails without the fix:

| Severity | Finding | Fix |
|---|---|---|
| Medium | No per-user connection limit: one account could open many sockets and multiply workspace-service checks | `MAX_SOCKETS_PER_USER` (default 10); extra sockets are disconnected |
| Medium | A transient workspace-service failure evicted rooms, and the web client never re-subscribed | The client retries with backoff after `unavailable` or `unsubscribed`; `not_found` stops it |
| Low | An unexpected error in a re-check could end the cycle early and skip sockets | Each socket's re-check is isolated; an unexpected error disconnects that socket (fail closed). Not covered by a test: no test double can make the check throw |
| Low | Concurrent subscribes could overshoot the room cap | The cap is checked again after the access check |
| Low | The client reset its reconnect backoff on every connect, so a session the gateway kept ending was retried every second | The backoff resets only after a subscription succeeds |

Accepted:
- `VITE_REALTIME_URL` is not validated. It is build-time configuration, as trusted as `VITE_API_BASE_URL`, which also receives the token.
- No per-IP connection limit: belongs at the reverse proxy.
- Subscribe/unsubscribe races only re-add channels the user is authorized for.
- A missing `Origin` is allowed: non-browser clients still need a token, and the token is not a cookie.

### Known limitations

- **No real email provider.** Production must set `ACCOUNT_NOTIFIER` and `INVITATION_NOTIFIER` to `disabled`. Locally, read emails with `GET /dev/mailbox` on :3101 and :3102.
- **Organization creation** depends on the `ORGANIZATION_CREATOR_EMAILS` allowlist. No platform-admin concept exists.
- **No event relay (ADR 0002 not approved).** Member projections (names, emails) can go stale. Removed members' workspace rows stay until pruned or relayed; they are ineffective.
- **Realtime:**
  - **Best effort:** Redis pub/sub keeps nothing, so events published while the gateway is disconnected are lost. The first publish after messaging starts can be lost while Redis connects. Clients recover by refetching on (re)subscribe and by the 60 s safety poll.
  - **Revocation latency:** access loss is detected at the next re-check (60 s by default), not instantly.
  - **Limits are per socket and in memory.**
  - **Not built:** typing, presence, read state.
- **No membership caching:** each workspace request makes one organization call; each message request, and each realtime subscribe or re-check, makes a workspace call that also includes an organization call.
- **Not started:**
  - direct and group messages, threads, reactions, mentions, read state;
  - files, search, notifications.

  Their authorization therefore cannot be tested yet.
- **Frontend:**
  - missing edit screens for departments, teams, workspaces and organization settings;
  - missing screens for sessions and password change;
  - no real-browser run (the built-in browser cannot open local servers). The realtime client was verified by unit tests and the socket protocol through the Vite proxy, not in a browser.

### Run locally

```bash
make infra-up && make db-migrate && make prisma-generate && make auth-dev-keys   # once
make identity-start                                                              # :3101
ORGANIZATION_CREATOR_EMAILS=you@example.com make organization-start              # :3102
make workspace-start                                                             # :3103
REDIS_URL='redis://:<REDIS_PASSWORD from .env>@127.0.0.1:6379/0' make messaging-start   # :3104
REDIS_URL='redis://:<REDIS_PASSWORD from .env>@127.0.0.1:6379/0' make realtime-start    # :3105
make gateway-start      # :3000 (restart your Task 2 gateway there first: it predates auth keys)
make web-dev            # http://127.0.0.1:5173 (proxies /api to :3000 and /realtime to :3105)
```

Messaging also runs without `REDIS_URL`; the web app then falls back to polling every 5 s. Verification emails: `curl 'http://127.0.0.1:3101/dev/mailbox?to=you@example.com'`. Invitations: the same, on :3102.

### Next action

1. **Decisions for you:**
   - approve or amend [ADR 0004](decisions/0004-realtime-gateway.md) (realtime) and [ADR 0010](decisions/0010-organizations-and-membership.md) (organizations and membership);
   - choose an event relay (ADR 0002) so projections and memberships stop going stale.
2. **Next roadmap task:** direct and group conversations on the existing messaging schema, with the same visibility model and realtime path.
