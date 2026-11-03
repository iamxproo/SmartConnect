// 30 simultaneous users (make load-30): 5 organizations of 6 people on the unified backend and the disposable test
// database. Per organization, the owner is a real Chrome session (signed in through the web app's API, working in the
// channel through the UI and its own Socket.IO connection) and 5 members are API + Socket.IO clients through the same
// public port. After the setup (register, verify, sign in, create the organization and workspace, invite, accept,
// join, open a group and direct conversations), everybody works at once: channel messages, thread replies,
// reactions, read markers, history, unread counts, group and direct messages, a file upload attached to a message
// and downloaded (and checksummed) by another member, cross-organization probes, token refresh, a socket disconnect
// and reconnect with history catch-up for a third of the members, and finally sign-out. Every realtime delivery to
// every online recipient is checked. Results (latency percentiles, status classes, deliveries, backend RSS/CPU,
// PostgreSQL and Redis connections) go to E2E_LOG_DIR/load-30-results.json.
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  createOrg,
  createWorkspace,
  expect,
  founderEmail,
  invitationToken,
  person,
  test,
  type Org,
  type Person,
  type Workspace,
} from '../e2e/support/fixtures.js';
import {
  ApiUser,
  expectDelivery,
  Metrics,
  ResourceSampler,
  sha256,
  sleep,
  think,
  THINK_MS,
} from './support/load-client.js';

const ORGS = 5;
const MEMBERS = 5; // plus the owner: 6 people per organization, 30 in all
const ITERATIONS = Number(process.env.LOAD_ITERATIONS ?? 10);
const BROWSER_ROUNDS = Number(process.env.LOAD_BROWSER_ROUNDS ?? 4);

// Client addresses for the API users: one per person, from the benchmarking range, a fresh block per run so the
// gateway's per-IP limits (kept in Redis across runs) treat every run's people as new machines.
const block = 20 + (randomBytes(1)[0]! % 200);
let host = 0;
const nextAddress = () => `198.18.${block}.${++host}`;

interface Sent {
  id: string;
  body: string;
  at: number;
  by: ApiUser;
}

interface SentInConversation {
  id: string;
  conversationId: string;
  at: number;
  to: ApiUser[];
}

interface Team {
  index: number;
  owner: Person;
  ownerApi: ApiUser;
  org: Org;
  workspace: Workspace;
  members: ApiUser[];
  channelPath: string;
  groupId: string;
  /** Direct conversation of each member, with its partner. */
  directs: Map<ApiUser, { id: string; partner: ApiUser }>;
  sent: Sent[];
  sentInConversations: SentInConversation[];
}

async function setUpTeam(browser: Parameters<typeof person>[0], metrics: Metrics, index: number): Promise<Team> {
  const owner = await person(browser, `Owner${index}`, founderEmail());
  const org = await createOrg(owner, `Load ${index} ${randomUUID().slice(0, 6)}`);
  const workspace = await createWorkspace(owner, org);
  const ownerApi = new ApiUser(`o${index}`, owner.email, nextAddress(), metrics);
  ownerApi.accessToken = owner.token;
  ownerApi.id = owner.userId;
  const channelPath = `/orgs/${org.id}/workspaces/${workspace.id}/channels/${workspace.generalId}/messages`;
  const members = Array.from(
    { length: MEMBERS },
    (_, j) => new ApiUser(`o${index}m${j}`, `load-${index}-${j}-${randomUUID()}@example.com`, nextAddress(), metrics),
  );
  await Promise.all(
    members.map(async (m, j) => {
      await m.signUp(`Member ${index}.${j}`);
      await ownerApi.call('POST', `/orgs/${org.id}/invitations`, {
        category: 'org_invite',
        body: { email: m.email, roleId: org.roles.member },
      });
      const token = await invitationToken(m.email);
      await m.call('POST', '/invitations/accept', { category: 'org_accept', body: { token } });
      await m.call('POST', `/orgs/${org.id}/workspaces/${workspace.id}/join`, { category: 'workspace_join' });
    }),
  );
  // A group of everybody (opened by the first member) and a direct conversation for each member.
  const group = await members[0]!.call<{ id: string }>('POST', `/orgs/${org.id}/conversations/groups`, {
    category: 'conversation_create',
    body: { title: `Team ${index}`, userIds: [...members.slice(1).map((m) => m.id), owner.userId] },
  });
  const directs = new Map<ApiUser, { id: string; partner: ApiUser }>();
  for (const [a, b] of [
    [0, 1],
    [2, 3],
    [4, 0],
  ] as const) {
    const opened = await members[a]!.call<{ id: string }>('POST', `/orgs/${org.id}/conversations/direct`, {
      category: 'conversation_create',
      body: { userId: members[b]!.id },
    });
    if (!directs.has(members[a]!)) directs.set(members[a]!, { id: opened.body.id, partner: members[b]! });
    if (!directs.has(members[b]!)) directs.set(members[b]!, { id: opened.body.id, partner: members[a]! });
  }
  return {
    index,
    owner,
    ownerApi,
    org,
    workspace,
    members,
    channelPath,
    groupId: group.body.id,
    directs,
    sent: [],
    sentInConversations: [],
  };
}

test('30 simultaneous users across 5 organizations', async ({ browser }) => {
  test.setTimeout(20 * 60_000);
  const metrics = new Metrics();
  const sampler = new ResourceSampler();
  await sampler.start();
  await sampler.footprint('before setup');
  const timings: Record<string, number> = {};
  const started = Date.now();

  // ---- setup, all organizations at once ----
  const teams = await Promise.all(Array.from({ length: ORGS }, (_, i) => setUpTeam(browser, metrics, i)));
  timings.setupMs = Date.now() - started;
  const everybody = teams.flatMap((t) => t.members);
  expect(everybody.filter((m) => m.id && m.accessToken)).toHaveLength(ORGS * MEMBERS);

  // Every owner opens the channel in the browser; every member connects and subscribes.
  await Promise.all(
    teams.map(async (t) => {
      await t.owner.page.goto(`/o/${t.org.slug}/w/${t.workspace.id}/c/${t.workspace.generalId}`);
      await expect(t.owner.page.getByRole('textbox', { name: 'Message #general' })).toBeVisible({ timeout: 30_000 });
    }),
  );
  // After an eviction (the gateway could not re-check access), the web app resubscribes and refetches: everything
  // sent to the user from shortly before the eviction until the resubscription must then be in the history.
  for (const t of teams)
    for (const m of t.members)
      m.onRecovered = async ({ room, from, to }) => {
        const window = (at: number) => at >= from - 10_000 && at <= to!;
        const due =
          room === 'channel'
            ? t.sent.filter((s) => s.by !== m && s.body && window(s.at)).map((s) => ({ id: s.id, path: t.channelPath }))
            : t.sentInConversations
                .filter((s) => s.to.includes(m) && window(s.at))
                .map((s) => ({ id: s.id, path: `/orgs/${t.org.id}/conversations/${s.conversationId}/messages` }));
        for (const path of new Set(due.map((d) => d.path))) {
          const page = await m.call<{ data: { id: string }[] }>('GET', `${path}?limit=100`, { category: 'catch_up' });
          const ids = new Set((page.body.data ?? []).map((d) => d.id));
          const gaps = due.filter((d) => d.path === path && !ids.has(d.id));
          if (gaps.length) metrics.recoveryFailures.push(`${m.label} ${room}: ${gaps.length} missing after eviction`);
          metrics.catchUpChecked += due.filter((d) => d.path === path).length;
        }
      };
  const connectStarted = Date.now();
  await Promise.all(
    teams.flatMap((t) =>
      t.members.map((m) =>
        m.connect({ organizationId: t.org.id, workspaceId: t.workspace.id, channelId: t.workspace.generalId }),
      ),
    ),
  );
  timings.socketConnectAllMs = Date.now() - connectStarted;
  await sampler.footprint('all 30 signed in and connected');

  // ---- everybody at once ----
  sampler.mark('concurrent');
  const concurrentStarted = Date.now();
  const deliveries: Promise<void>[] = [];
  const otherTeam = (t: Team) => teams[(t.index + 1) % teams.length]!;
  const reconnecting = new Set(everybody.filter((_, i) => i % 3 === 0)); // 9 of 25
  const offline = new Map<ApiUser, number>();

  const member = async (t: Team, m: ApiUser, j: number) => {
    const others = () => t.members.filter((o) => o !== m && o.online);
    const groupOthers = () => t.members.filter((o) => o !== m && o.online); // the owner's inbox is the browser's
    for (let it = 0; it < ITERATIONS; it++) {
      // Channel message, delivered to every other online member of the organization.
      const body = `load ${m.label} #${it} ${randomUUID().slice(0, 8)}`;
      const recipients = others();
      const sentAt = Date.now();
      const posted = await m.call<{ id: string }>('POST', t.channelPath, {
        category: 'channel_post',
        body: { body, clientMessageId: randomUUID() },
      });
      if (posted.status === 201) {
        t.sent.push({ id: posted.body.id, body, at: sentAt, by: m });
        deliveries.push(expectDelivery(metrics, 'channel', 'channel', posted.body.id, sentAt, recipients, offline));
      }
      await think();

      const history = await m.call<{ data: { id: string }[] }>('GET', `${t.channelPath}?limit=50`, {
        category: 'channel_history',
      });
      const newest = history.body.data?.[0]?.id;
      if (newest) {
        await m.call('POST', `${t.channelPath}/read`, { category: 'channel_read', body: { messageId: newest } });
        await m.call('PUT', `${t.channelPath}/${newest}/reactions/${encodeURIComponent(['👍', '🎉', '✅'][it % 3]!)}`, {
          category: 'reaction',
        });
      }
      if (it % 2 === 1 && posted.status === 201)
        await m.call('POST', t.channelPath, {
          category: 'thread_reply',
          body: { body: `reply ${m.label} #${it}`, threadRootId: posted.body.id },
        });
      await think();

      // Group message, delivered to every other online member's inbox.
      const groupRecipients = groupOthers();
      const groupSentAt = Date.now();
      const inGroup = await m.call<{ id: string }>('POST', `/orgs/${t.org.id}/conversations/${t.groupId}/messages`, {
        category: 'group_post',
        body: { body: `group ${m.label} #${it}` },
      });
      if (inGroup.status === 201) {
        t.sentInConversations.push({
          id: inGroup.body.id,
          conversationId: t.groupId,
          at: groupSentAt,
          to: t.members.filter((o) => o !== m),
        });
        deliveries.push(
          expectDelivery(metrics, 'group', 'inbox', inGroup.body.id, groupSentAt, groupRecipients, offline),
        );
        await m.call('POST', `/orgs/${t.org.id}/conversations/${t.groupId}/read`, {
          category: 'conversation_read',
          body: { messageId: inGroup.body.id },
        });
      }

      // Direct message to the member's partner.
      const direct = t.directs.get(m)!;
      const directRecipients = direct.partner.online ? [direct.partner] : [];
      const directSentAt = Date.now();
      const inDirect = await m.call<{ id: string }>('POST', `/orgs/${t.org.id}/conversations/${direct.id}/messages`, {
        category: 'direct_post',
        body: { body: `direct ${m.label} #${it}` },
      });
      if (inDirect.status === 201) {
        t.sentInConversations.push({
          id: inDirect.body.id,
          conversationId: direct.id,
          at: directSentAt,
          to: [direct.partner],
        });
        deliveries.push(
          expectDelivery(metrics, 'direct', 'inbox', inDirect.body.id, directSentAt, directRecipients, offline),
        );
      }
      await think();

      await m.call('GET', `/orgs/${t.org.id}/conversations`, { category: 'conversation_list' });
      await m.call('GET', `/orgs/${t.org.id}/activity/unread-count`, { category: 'unread_count' });

      if (it === 2) {
        // A file attached to a channel message; the next member downloads it and checks every byte; a member of
        // another organization is refused.
        const bytes = new Uint8Array(randomBytes(32_768 + Math.floor(Math.random() * 229_376)));
        const created = await m.call<{ id: string }>('POST', `/orgs/${t.org.id}/files`, {
          category: 'file_create',
          body: { name: `load-${m.label}.bin`, sizeBytes: bytes.byteLength },
        });
        if (created.status === 201) {
          const fileId = created.body.id;
          await m.call('PUT', `/orgs/${t.org.id}/files/${fileId}/content`, { category: 'file_upload', raw: bytes });
          const attached = await m.call<{ id: string }>('POST', t.channelPath, {
            category: 'attachment_post',
            body: { body: `file from ${m.label}`, attachmentFileIds: [fileId] },
          });
          if (attached.status === 201) t.sent.push({ id: attached.body.id, body: '', at: Date.now(), by: m });
          const reader = t.members[(j + 1) % MEMBERS]!;
          const download = await reader.call('GET', `/orgs/${t.org.id}/files/${fileId}/content`, {
            category: 'file_download',
          });
          metrics.fileChecks += 1;
          if (download.status !== 200 || !download.bytes || sha256(download.bytes) !== sha256(bytes))
            metrics.fileFailures.push(`${reader.label} read ${fileId}: ${download.status}`);
          const outsider = otherTeam(t).members[j]!;
          await outsider.call('GET', `/orgs/${t.org.id}/files/${fileId}/content`, {
            category: 'isolation_file',
            expect: [404],
          });
        }
      }
      if (it === 3) {
        // Another organization's channel, with a valid session: indistinguishable from a channel that does not exist.
        await m.call('GET', `${otherTeam(t).channelPath}?limit=1`, { category: 'isolation_channel', expect: [404] });
      }
      if (it === 4) await m.refresh();
      if (it === 5 && reconnecting.has(m)) {
        // Drop the connection, come back with a refreshed token, and catch up from history.
        const droppedAt = Date.now();
        offline.set(m, droppedAt);
        m.disconnect();
        await sleep(1_500);
        await m.refresh();
        const ok = await m.connect({
          organizationId: t.org.id,
          workspaceId: t.workspace.id,
          channelId: t.workspace.generalId,
        });
        const backAt = Date.now();
        metrics.reconnects += 1;
        if (!ok) metrics.reconnectFailures.push(`${m.label}: reconnect refused`);
        const missedWhileAway = t.sent.filter((s) => s.by !== m && s.at >= droppedAt && s.at <= backAt && s.body);
        const caughtUp = await m.call<{ data: { id: string }[] }>('GET', `${t.channelPath}?limit=100`, {
          category: 'channel_history',
        });
        const ids = new Set((caughtUp.body.data ?? []).map((d) => d.id));
        const gaps = missedWhileAway.filter((s) => !ids.has(s.id));
        if (gaps.length) metrics.reconnectFailures.push(`${m.label}: ${gaps.length} messages missing from history`);
        metrics.catchUpChecked += missedWhileAway.length;
        offline.delete(m);
      }
      await think();
    }
  };

  // The owner, in Chrome: sends from the composer (members' sockets must see it) and watches members' messages
  // arrive in the open channel (the page's own realtime connection).
  const owner = async (t: Team) => {
    const page = t.owner.page;
    const log = page.getByRole('log', { name: 'Messages in #general' });
    for (let k = 0; k < BROWSER_ROUNDS; k++) {
      await sleep(THINK_MS * (3 + Math.random() * 5));
      const body = `ui ${t.ownerApi.label} #${k} ${randomUUID().slice(0, 8)}`;
      const recipients = t.members.filter((m) => m.online);
      await page.getByRole('textbox', { name: 'Message #general' }).fill(body);
      const sentAt = Date.now();
      await page.getByRole('button', { name: 'Send message' }).click();
      // The composer shows the message at once, as "sending"; it is stored when the POST answers, so look for it in
      // the history until then (the delivery latency comes from the sockets' own arrival times, not from this loop).
      await expect(log.getByText(body)).toBeVisible({ timeout: 15_000 });
      metrics.record('ui_send_visible', 200, Date.now() - sentAt, true, t.ownerApi.label);
      let id: string | undefined;
      for (const deadline = Date.now() + 15_000; !id && Date.now() < deadline;) {
        const recent = await t.ownerApi.call<{ data: { id: string; body: string }[] }>(
          'GET',
          `${t.channelPath}?limit=50`,
          { category: 'channel_history' },
        );
        id = recent.body.data?.find((d) => d.body === body)?.id;
        if (!id) await sleep(100);
      }
      if (id) metrics.record('ui_send_stored', 200, Date.now() - sentAt, true, t.ownerApi.label);
      if (id) deliveries.push(expectDelivery(metrics, 'from_browser', 'channel', id, sentAt, recipients, offline));
      else metrics.missed.push(`from_browser ${body}: not in history`);

      // A member's message appearing in the owner's open channel.
      const sender = t.members[k % MEMBERS]!;
      const probe = `probe ${sender.label} #${k} ${randomUUID().slice(0, 8)}`;
      const probeAt = Date.now();
      const [res, seen] = await Promise.all([
        sender.call('POST', t.channelPath, { category: 'channel_post', body: { body: probe } }),
        log
          .getByText(probe)
          .waitFor({ timeout: 15_000 })
          .then(() => Date.now())
          .catch(() => undefined),
      ]);
      if (res.status !== 201) continue; // recorded as an unexpected response
      if (seen === undefined) metrics.missed.push(`to_browser ${probe} -> ${t.ownerApi.label}`);
      else metrics.deliveries.push({ kind: 'to_browser', ms: seen - probeAt });
    }
  };

  await Promise.all([...teams.flatMap((t) => t.members.map((m, j) => member(t, m, j))), ...teams.map((t) => owner(t))]);
  await Promise.all(deliveries);
  // Evictions near the end: give their resubscription (backoff up to 30 s) and catch-up time to finish.
  for (const deadline = Date.now() + 45_000; Date.now() < deadline; await sleep(250))
    if (everybody.every((m) => m.evictions.every((e) => e.checked))) break;
  timings.concurrentMs = Date.now() - concurrentStarted;
  await sampler.footprint('after concurrent phase');

  // ---- sessions still valid, then sign-out ----
  sampler.mark('teardown');
  await Promise.all(everybody.map((m) => m.call('GET', '/auth/me', { category: 'auth_me' })));
  await Promise.all(
    teams.map(async (t) => {
      // A reload restores the browser session from its refresh cookie and reopens the channel with its history.
      await t.owner.page.reload();
      await expect(t.owner.page.getByRole('textbox', { name: 'Message #general' })).toBeVisible({ timeout: 30_000 });
      await expect(t.owner.page.getByRole('log', { name: 'Messages in #general' })).toContainText('ui ');
    }),
  );
  await Promise.all(
    everybody.map(async (m) => {
      m.disconnect();
      const old = m.refreshToken;
      await m.call('POST', '/auth/logout', { token: null, category: 'auth_logout', body: { refreshToken: old } });
      await m.call('POST', '/auth/refresh', {
        token: null,
        category: 'auth_refresh_after_logout',
        expect: [401],
        body: { refreshToken: old },
      });
    }),
  );
  timings.totalMs = Date.now() - started;

  // ---- results ----
  const resources = sampler.stop();
  const logDir = process.env.E2E_LOG_DIR!;
  // The backend's JSON log lines written while this test ran (warn and above at the stack's log level), by level, and
  // every error line by application, event, status and route (ids replaced): backend.log on the unified backend, one
  // log per service in the seven-process stack. Vite's log is not the backend's.
  const backendLogs = readdirSync(logDir)
    .filter((name) => name.endsWith('.log') && name !== 'vite.log')
    .map((name) => ({ name: name.replace(/\.log$/, ''), text: readFileSync(path.join(logDir, name), 'utf8') }));
  const levels: Record<string, number> = {};
  const errors = new Map<string, number>();
  for (const { name, line } of backendLogs.flatMap((log) =>
    log.text
      .split('\n')
      .filter(Boolean)
      .map((line) => ({ name: log.name, line })),
  )) {
    type Fields = { event?: string; status?: number; method?: string; path?: string; error?: string };
    let entry: { level?: string; timestamp?: number; app?: string; context?: string; message?: Fields | string };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      entry = { level: 'unparsed', message: line.slice(0, 120) };
    }
    if (entry.timestamp !== undefined && entry.timestamp < started) continue;
    const level = entry.level ?? 'unknown';
    levels[level] = (levels[level] ?? 0) + 1;
    if (level === 'error' || level === 'fatal' || level === 'unparsed') {
      const m = typeof entry.message === 'string' ? { event: entry.message.slice(0, 120) } : (entry.message ?? {});
      const route = (m.path ?? '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id');
      const key = [entry.app ?? name, m.event, m.status, m.method, route, m.error?.slice(0, 120)]
        .filter((part) => part !== undefined && part !== '')
        .join(' ');
      errors.set(key, (errors.get(key) ?? 0) + 1);
    }
  }
  const summary = metrics.summary();
  const results = {
    users: { total: ORGS * (MEMBERS + 1), browsers: ORGS, apiClients: ORGS * MEMBERS, organizations: ORGS },
    iterations: ITERATIONS,
    browserRounds: BROWSER_ROUNDS,
    thinkMs: THINK_MS,
    realtimeReauthorizeSeconds: Number(process.env.E2E_REAUTHORIZE_INTERVAL_SECONDS ?? 5),
    timings,
    ...summary,
    unexpected: metrics.unexpected.slice(0, 50),
    missed: metrics.missed.slice(0, 50),
    socketFailures: metrics.socketFailures,
    reconnectFailures: metrics.reconnectFailures,
    recoveryFailures: metrics.recoveryFailures,
    fileFailures: metrics.fileFailures,
    resources,
    backendLog: { files: backendLogs.map((log) => log.name), levels, errors: Object.fromEntries(errors) },
  };
  const file = path.join(logDir, 'load-30-results.json');
  writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(`[load-30] results in ${file}`);
  console.log(
    JSON.stringify({
      requests: summary.requests,
      unexpected: summary.unexpectedResponses,
      status5xx: summary.status5xx,
      deliveries: summary.deliveries,
      sockets: summary.sockets,
      files: summary.files,
      latencyMs: summary.latencyMs,
      timings,
    }),
  );

  expect(metrics.unexpected, 'unexpected responses').toEqual([]);
  expect(summary.status5xx, '5xx responses').toBe(0);
  expect(metrics.socketFailures, 'socket connection failures').toEqual([]);
  expect(metrics.missed, 'realtime deliveries missed').toEqual([]);
  expect(metrics.reconnectFailures, 'reconnect / catch-up failures').toEqual([]);
  expect(metrics.recoveryFailures, 'catch-up failures after an eviction').toEqual([]);
  const unrecovered = everybody.flatMap((m) => m.evictions.filter((e) => !e.checked).map(() => m.label));
  expect(unrecovered, 'evicted rooms never subscribed again').toEqual([]);
  expect(metrics.fileFailures, 'file download / checksum failures').toEqual([]);
  expect(summary.sockets.connects).toBe(ORGS * MEMBERS + reconnecting.size);
  expect(errors.size, 'error lines in backend.log').toBe(0);
});
