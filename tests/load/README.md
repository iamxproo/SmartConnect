# Load tests

## `make load-30` — 30 simultaneous users

`thirty-users.spec.ts` runs 30 signed-in people at once on the **unified backend** (one process, ADR 0016 Phase 1)
and the **disposable test database**, started by the browser tests' global setup (`../e2e/support/stack.ts`: public
port 3300, internal 3301–3305 and 3309, Vite on 5174). It never touches the dev database or a running dev stack.

- 5 organizations × 6 people. In each, the **owner is a real Chrome session** in the channel (composer and the page's
  own realtime connection), and **5 members are API + Socket.IO clients** through the same public port, each with its
  own client address (X-Forwarded-For, trusted only by the test gateway), so the per-IP limits stay on.
- Setup through the public API: register, verify (dev mailbox), sign in, create organization and workspace, invite,
  accept, join, open a group and direct conversations.
- Then everybody at once (`LOAD_ITERATIONS`, default 10, per member; `LOAD_BROWSER_ROUNDS`, default 4, per owner):
  channel messages, thread replies, reactions, read markers, history, unread counts, conversation lists, group and
  direct messages, a file upload attached to a message and downloaded and checksummed by another member, a member of
  another organization refused the file and the channel (404), token refresh, a deliberate disconnect and reconnect
  with history catch-up for 9 of the 25 members, UI sends seen by the members' sockets and members' messages seen in
  the owners' open channel. Every realtime delivery to every online recipient is checked.
- Sockets behave like the web app's realtime client: when the gateway evicts a room because it could not re-check
  access (it fails closed), they resubscribe with the web app's backoff and must then find everything they missed in
  the history. Evictions, refused resubscriptions and catch-up checks are counted in the results.
- Finally: every session still valid, browser reload restores the session, sign-out, and the old refresh token refused.

**Pace.** `LOAD_THINK_MS` is the mean pause between a person's actions (default 375 ms: a stress pace, roughly
45 requests/s from 25 members, far above 30 people chatting). `E2E_REAUTHORIZE_INTERVAL_SECONDS` sets how often the
realtime gateway re-checks every open socket's access (the browser tests use 5 s; the production default is 60 s).
A realistic-pace run: `make load-30 LOAD_THINK_MS=3000 E2E_REAUTHORIZE_INTERVAL_SECONDS=60`.

The test fails on any unexpected status, any 5xx, any missed delivery, any socket, reconnect, catch-up or checksum
failure and any error line in the backend log. Results — latency percentiles per operation and per delivery kind,
status classes, backend RSS/CPU/footprint, its PostgreSQL and Redis connections, PostgreSQL sessions per role — go to
`load-30-results.json` in the log directory printed at start (`E2E_LOG_DIR`).

For comparison, the same test runs against the seven-process stack (the rollback topology) with
`cd tests && npx playwright test --config load/playwright.config.ts` (no `E2E_BACKEND`; sockets then use the realtime
gateway's own port, as the web app's dev proxy does, and the resource figures are the sum of the seven processes).

Run it while nothing else uses the test database (`make db-test`, `make e2e`, `make e2e-unified`); it needs the same
ports as the browser tests.

**Not covered here:** the 1,000–1,500 connected users / 10–30 concurrent meeting rooms target (meetings do not exist
yet), multi-instance deployments, and production infrastructure.
