// Supertest response bodies are untyped JSON; the assertions below read them directly.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, query } from '../../support/database.js';
import {
  Chan,
  db,
  forgedTokenFor,
  problemOf,
  scenario,
  startMessaging,
  tokenFor,
  type HttpMethod,
  type TestMessaging,
} from './support/messaging.js';

let svc: TestMessaging;
beforeAll(async () => {
  svc = await startMessaging();
});
afterAll(async () => {
  await svc.close();
});

/** Every route of the contract against one channel. */
const routes = (chan: Chan, messageId: string): [HttpMethod, string, object?][] => [
  ['get', chan.path()],
  ['post', chan.path(), { body: 'probe' }],
  ['patch', chan.path(`/${messageId}`), { body: 'probe' }],
  ['delete', chan.path(`/${messageId}`)],
];

const send = async (method: HttpMethod, url: string, userId: string, body?: object) => {
  const req = request(svc.server)[method](url);
  req.set('Authorization', `Bearer ${await tokenFor(userId)}`);
  return body === undefined ? req : req.send(body);
};

describe('channel visibility is decided by the workspace service on every request', () => {
  it('answers 404 on every route for an invisible channel and writes nothing', async () => {
    const { chan, member, outsider } = scenario(svc);
    const alice = member();
    const msg = (await alice.post(chan, { body: 'inside' })).body;
    const stranger = outsider();
    const events = await db.count('SELECT count(*) AS n FROM messaging.outbox_events WHERE organization_id = $1', [
      chan.orgId,
    ]);
    for (const [method, url, body] of routes(chan, msg.id)) {
      const res = await send(method, url, stranger.userId, body);
      expect(res.status, `${method} ${url}`).toBe(404);
      expect(problemOf(res).code).toBe('not_found');
    }
    expect(await db.messageCount(chan)).toBe(1);
    expect(
      (await db.rows<{ body: string }>('SELECT body FROM messaging.messages WHERE id = $1', [msg.id]))[0]!.body,
    ).toBe('inside');
    expect(
      await db.count('SELECT count(*) AS n FROM messaging.outbox_events WHERE organization_id = $1', [chan.orgId]),
    ).toBe(events);
  });

  it('writes no conversation when an invisible channel is posted to', async () => {
    const { chan, outsider } = scenario(svc);
    expect((await outsider().post(chan, { body: 'x' })).status).toBe(404);
    expect(await db.conversationCount(chan)).toBe(0);
  });

  it('hides a private channel from someone who is not in it, whatever their role elsewhere', async () => {
    const { chan, member } = scenario(svc);
    await member().post(chan, { body: 'private history' });
    // An organization / workspace admin who is not a channel member: the workspace service answers 404, no bypass.
    const orgAdmin = scenario(svc).admin(); // admin of ANOTHER channel only
    const list = await orgAdmin.list(chan);
    expect(list.status).toBe(404);
    expect(JSON.stringify(list.body)).not.toContain('private history');
    expect((await orgAdmin.remove(chan, randomUUID())).status).toBe(404);
  });

  it('revokes access immediately when the workspace service stops showing the channel', async () => {
    const { chan, member } = scenario(svc);
    const alice = member();
    expect((await alice.post(chan, { body: 'while a member' })).status).toBe(201);
    svc.workspace.hide(chan, alice.userId);
    expect((await alice.list(chan)).status).toBe(404);
    expect((await alice.post(chan, { body: 'after removal' })).status).toBe(404);
  });

  it('does not let a channel admin of one channel moderate another', async () => {
    const one = scenario(svc);
    const two = scenario(svc);
    const msg = (await two.member().post(two.chan, { body: 'other channel' })).body;
    const boss = one.admin();
    for (const chan of [one.chan, two.chan]) {
      const res = await boss.remove(chan, msg.id);
      expect(res.status).toBe(404);
    }
    expect(
      (await db.rows<{ body: string }>('SELECT body FROM messaging.messages WHERE id = $1', [msg.id]))[0]!.body,
    ).toBe('other channel');
  });
});

describe('message ids are scoped to the channel in the path', () => {
  it('returns 404 for ids of another channel, another organization, unknown ids and malformed ids', async () => {
    const mine = scenario(svc);
    const theirs = scenario(svc);
    const alice = mine.member();
    await alice.post(mine.chan, { body: 'mine' });
    const foreign = (await theirs.member().post(theirs.chan, { body: 'foreign' })).body;

    for (const id of [foreign.id, randomUUID(), 'not-a-uuid', '1']) {
      const edit = await alice.edit(mine.chan, id, { body: 'overwrite' });
      expect(edit.status, `edit ${id}`).toBe(404);
      const del = await alice.remove(mine.chan, id);
      expect(del.status, `delete ${id}`).toBe(404);
    }
    const [row] = await db.rows<{ body: string; edited_at: Date | null; deleted_at: Date | null }>(
      'SELECT body, edited_at, deleted_at FROM messaging.messages WHERE id = $1',
      [foreign.id],
    );
    expect(row).toEqual({ body: 'foreign', edited_at: null, deleted_at: null });
  });

  it('keeps organizations apart: a message id of another organization is never found or touched', async () => {
    const { chan, member } = scenario(svc);
    const alice = member();
    const msg = (await alice.post(chan, { body: 'org A' })).body;
    // Channel ids are globally unique, so another organization has its own channel; alice is admin there.
    const otherOrg = new Chan(randomUUID(), randomUUID(), randomUUID());
    svc.workspace.show(otherOrg, alice.userId, { isMember: true, myRole: 'admin' });
    expect((await alice.list(otherOrg)).body.data).toEqual([]);
    expect((await alice.post(otherOrg, { body: 'org B' })).status).toBe(201);
    expect((await alice.edit(otherOrg, msg.id, { body: 'x' })).status).toBe(404);
    expect((await alice.remove(otherOrg, msg.id)).status).toBe(404);
    // The path's organization is the tenant: the org A channel under org B's path is invisible to the workspace service.
    expect((await alice.list(chan.inOrg(otherOrg.orgId))).status).toBe(404);
    expect((await alice.list(chan)).body.data.map((m: { body: string }) => m.body)).toEqual(['org A']);
    expect((await alice.list(otherOrg)).body.data.map((m: { body: string }) => m.body)).toEqual(['org B']);
    expect(
      (
        await db.rows<{ body: string; deleted_at: Date | null }>(
          'SELECT body, deleted_at FROM messaging.messages WHERE id = $1',
          [msg.id],
        )
      )[0],
    ).toEqual({ body: 'org A', deleted_at: null });
  });

  it('denies a non-sender non-admin delete and edit', async () => {
    const { chan, member } = scenario(svc);
    const alice = member();
    const bob = member();
    const msg = (await alice.post(chan, { body: 'mine' })).body;
    expect((await bob.edit(chan, msg.id, { body: 'x' })).status).toBe(403);
    expect((await bob.remove(chan, msg.id)).status).toBe(403);
    expect((await alice.list(chan)).body.data[0].body).toBe('mine');
  });
});

describe('failing closed', () => {
  it.each(['error', 'garbage', 'wrong-id'] as const)(
    'answers 503 when the workspace service misbehaves: %s',
    async (mode) => {
      const { chan, member } = scenario(svc);
      const alice = member();
      svc.workspace.break(chan, alice.userId, mode);
      const msg = randomUUID();
      for (const [method, url, body] of routes(chan, msg)) {
        const res = await send(method, url, alice.userId, body);
        expect(res.status, `${method} ${url}`).toBe(503);
        expect(problemOf(res).code).toBe('dependency_unavailable');
      }
      expect(await db.messageCount(chan)).toBe(0);
      expect(await db.conversationCount(chan)).toBe(0);
    },
  );

  it('maps a workspace 401 to 401 and a 403 to 404', async () => {
    const { chan, member } = scenario(svc);
    const alice = member();
    svc.workspace.break(chan, alice.userId, 'unauthorized');
    expect((await alice.list(chan)).status).toBe(401);
    svc.workspace.break(chan, alice.userId, 'forbidden');
    expect((await alice.list(chan)).status).toBe(404);
  });

  it('answers 503 when the workspace service is down, and writes nothing', async () => {
    const down = await startMessaging({ workspaceServiceUrl: 'http://127.0.0.1:1' });
    try {
      const chan = new Chan();
      const user = randomUUID();
      const token = await tokenFor(user);
      for (const [method, url, body] of routes(chan, randomUUID())) {
        const req = request(down.server)[method](url).set('Authorization', `Bearer ${token}`);
        const res = await (body === undefined ? req : req.send(body));
        expect(res.status, `${method} ${url}`).toBe(503);
      }
      expect(await db.conversationCount(chan)).toBe(0);
    } finally {
      await down.close();
    }
  });
});

describe('authentication', () => {
  it('rejects missing, malformed and forged tokens on every route, before asking the workspace service', async () => {
    const { chan } = scenario(svc);
    const before = svc.workspace.requests.length;
    const wrongKey = await forgedTokenFor(randomUUID());
    for (const [method, url, body] of routes(chan, randomUUID())) {
      const bare = await request(svc.server)[method](url);
      expect(bare.status, `${method} ${url}`).toBe(401);
      for (const token of ['aaa.bbb.ccc', wrongKey, 'garbage']) {
        const req = request(svc.server)[method](url).set('Authorization', `Bearer ${token}`);
        const res = await (body === undefined ? req : req.send(body));
        expect(res.status, `${method} ${url}`).toBe(401);
      }
    }
    expect(svc.workspace.requests.length).toBe(before);
  });

  it('keeps health probes public and unknown paths 404', async () => {
    expect((await request(svc.server).get('/health/live')).status).toBe(200);
    expect((await request(svc.server).get('/health/ready')).status).toBe(200);
    expect((await request(svc.server).get('/api/v1/nothing-here')).status).toBe(404);
    const { chan } = scenario(svc);
    const noMessages = await send('get', chan.path().replace('/messages', ''), randomUUID());
    expect(noMessages.status).toBe(404);
  });
});

describe('row-level security and logging', () => {
  it('shows no rows to the runtime role without a tenant context', async () => {
    const { chan, member } = scenario(svc);
    await member().post(chan, { body: 'rls' });
    for (const table of ['conversations', 'messages']) {
      const rows = await query<{ n: string }>(appUrl('messaging'), `SELECT count(*) AS n FROM messaging.${table}`);
      expect(Number(rows[0]!.n), table).toBe(0);
    }
    expect(await db.messageCount(chan)).toBe(1);
  });

  it('never logs message bodies or tokens', async () => {
    const { chan, member } = scenario(svc);
    const alice = member();
    const marker = `body-marker-${randomUUID()}`;
    const msg = (await alice.post(chan, { body: marker, clientMessageId: 'log-check' })).body;
    await alice.edit(chan, msg.id, { body: `${marker}-edited` });
    await alice.list(chan);
    await alice.post(chan, { body: '   ' }); // validation failure path
    svc.workspace.break(chan, alice.userId, 'error');
    await alice.list(chan); // dependency failure path
    const token = await tokenFor(alice.userId);
    const logs = svc.logger.lines.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(marker);
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(token.split('.')[1]!);
  });
});
