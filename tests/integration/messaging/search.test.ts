// Supertest response bodies are untyped JSON; the assertions below read them directly.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Channel, Person, startCollab, type Collab } from './support/collab.js';
import { asPerson } from './support/collab.js';
import { db, problemOf } from './support/messaging.js';

let w: Collab;
beforeAll(async () => {
  w = await startCollab();
});
afterAll(async () => {
  await w.close();
});

/** A letters-only token, unique per call, so that suites sharing one database never see each other's messages. */
const word = () =>
  `w${randomUUID()
    .replace(/-/g, '')
    .replace(/\d/g, (d) => 'ghijklmnop'[Number(d)]!)}`;
const enc = encodeURIComponent;
const find = (who: Person, q: string, extra = '') =>
  who.get(`/api/v1/orgs/${who.orgId}/message-search?q=${enc(q)}${extra}`);
const bodies = (res: { body: { data: { body: string }[] } }) => res.body.data.map((m) => m.body);
const attach = (messageId: string, orgId: string, name: string) =>
  db.rows(
    `INSERT INTO messaging.message_attachments (id, organization_id, message_id, file_id, name, mime_type, size_bytes)
     VALUES ($1, $2, $3, $4, $5, 'text/plain', 12)`,
    [randomUUID(), orgId, messageId, randomUUID(), name],
  );

describe('scope', () => {
  it('finds messages in visible channels and in my conversations, with a location', async () => {
    const ch = new Channel(w);
    const [alice, bob] = [ch.person(), ch.person()];
    const t = word();
    const posted = (await alice.post(ch.path(), { body: `hello ${t} there` })).body;
    const res = await find(bob, t);
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      id: posted.id,
      body: `hello ${t} there`,
      senderUserId: alice.userId,
      location: { kind: 'channel', workspaceId: ch.chan.wsId, channelId: ch.chan.chId },
      attachments: [],
      reactions: [],
    });
    expect(Object.keys(res.body).sort()).toEqual(['data', 'nextCursor']);

    const orgId = w.newOrg();
    const [a, b] = [w.member(orgId), w.member(orgId)];
    const id = (await a.openDirect(b)).body.id;
    await a.say(id, `direct ${t}`);
    const direct = await find(asPerson(w, b), t);
    expect(direct.body.data[0].location).toEqual({ kind: 'direct', conversationId: id });
    const gid = await a.group([b, w.member(orgId)]);
    await a.say(gid, `group ${t}`);
    const group = await find(asPerson(w, b), t, '&limit=1');
    expect(group.body.data[0].location).toEqual({ kind: 'group', conversationId: gid });
  });

  it('never searches private channels for non-members, admins included, or other organizations or conversations', async () => {
    const ch = new Channel(w);
    const [member, admin, reader] = [ch.person(), ch.person('admin'), ch.person('reader')];
    const t = word();
    await member.post(ch.path(), { body: `secret ${t}` });
    ch.hide(admin);
    ch.hide(reader);
    expect(bodies(await find(admin, t))).toEqual([]);
    expect(bodies(await find(reader, t))).toEqual([]);
    expect(bodies(await find(member, t))).toEqual([`secret ${t}`]);

    // same channel id asked under another organization
    const other = w.newOrg();
    const stranger = asPerson(w, w.member(other));
    w.svc.workspace.show(ch.chan.inOrg(other), stranger.userId, { isMember: true, myRole: 'admin' });
    expect(bodies(await find(stranger, t))).toEqual([]);

    // a conversation the caller is not in, even as an organization member
    const orgId = w.newOrg();
    const [a, b, outsider] = [w.member(orgId), w.member(orgId), w.member(orgId)];
    await a.say((await a.openDirect(b)).body.id, `dm ${t}`);
    await a.say(await a.group([b, w.member(orgId)]), `grp ${t}`);
    expect(bodies(await find(asPerson(w, outsider), t))).toEqual([]);
  });

  it('never finds history from before I joined, nor replies of roots I cannot see', async () => {
    const orgId = w.newOrg();
    const [a, b, c, late] = [w.member(orgId), w.member(orgId), w.member(orgId), w.member(orgId)];
    const gid = await a.group([b, c]);
    const t = word();
    const root = (await a.say(gid, `old root ${t}`)).body;
    await a.say(gid, `old message ${t}`);
    await new Promise((r) => setTimeout(r, 20));
    expect((await a.put(`/${gid}/participants/${late.userId}`)).status).toBeLessThan(300);
    await new Promise((r) => setTimeout(r, 20));
    await a.say(gid, `new message ${t}`);
    await a.post(`/${gid}/messages`, { body: `reply ${t}`, threadRootId: root.id });

    const seen = bodies(await find(asPerson(w, late), t));
    expect(seen).toEqual([`new message ${t}`]);
    expect(bodies(await find(asPerson(w, b), t)).sort()).toEqual(
      [`new message ${t}`, `old message ${t}`, `old root ${t}`, `reply ${t}`].sort(),
    );
  });

  it('never returns deleted messages', async () => {
    const ch = new Channel(w);
    const [alice, bob] = [ch.person(), ch.person()];
    const t = word();
    const gone = (await alice.post(ch.path(), { body: `gone ${t}` })).body;
    await alice.post(ch.path(), { body: `kept ${t}` });
    await alice.delete(ch.path(`/${gone.id}`));
    expect(bodies(await find(bob, t))).toEqual([`kept ${t}`]);
  });

  it('hides replies of a deleted root and finds replies of a visible root', async () => {
    const ch = new Channel(w);
    const alice = ch.person();
    const t = word();
    const root = (await alice.post(ch.path(), { body: `root ${t}` })).body;
    await alice.post(ch.path(), { body: `reply ${t}`, threadRootId: root.id });
    expect(bodies(await find(alice, t)).sort()).toEqual([`reply ${t}`, `root ${t}`]);
    await alice.delete(ch.path(`/${root.id}`));
    expect(bodies(await find(alice, t))).toEqual([]);
  });

  it('answers a filter outside my scope exactly like a search with no hits', async () => {
    const ch = new Channel(w);
    const [alice, bob] = [ch.person(), ch.person()];
    const mine = new Channel(w);
    const me = mine.person();
    const t = word();
    await alice.post(ch.path(), { body: `hidden ${t}` });
    await me.post(mine.path(), { body: `mine ${t}` });
    ch.hide(bob);
    const outside = await find(bob, t, `&channelId=${ch.chan.chId}`);
    const nothing = await find(bob, word());
    const unknown = await find(bob, t, `&conversationId=${randomUUID()}`);
    for (const res of [outside, nothing, unknown]) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [], nextCursor: null });
    }
    // a channel filter never widens: the caller's own channel does not match another channel's id
    expect((await find(me, t, `&channelId=${mine.chan.chId}`)).body.data).toHaveLength(1);
    expect((await find(me, t, `&channelId=${ch.chan.chId}`)).body).toEqual({ data: [], nextCursor: null });
  });

  it('fails closed with 503 when the workspace service fails', async () => {
    const ch = new Channel(w);
    const alice = ch.person();
    const t = word();
    await alice.post(ch.path(), { body: `x ${t}` });
    for (const mode of ['error', 'garbage'] as const) {
      w.svc.workspace.listFailure = mode;
      try {
        const res = await find(alice, t);
        expect(res.status).toBe(503);
        expect(JSON.stringify(res.body)).not.toContain(t);
      } finally {
        w.svc.workspace.listFailure = null;
      }
    }
    expect((await find(alice, t)).status).toBe(200);
  });

  it('reads every page of the visible-channels list, as the caller', async () => {
    const orgId = w.newOrg();
    const me = asPerson(w, w.member(orgId));
    const chans = [0, 1, 2].map(() => new Channel(w).chan.inOrg(orgId));
    const t = word();
    const writers = chans.map((c) => {
      const writer = asPerson(w, w.member(orgId));
      w.svc.workspace.show(c, writer.userId, { isMember: true, myRole: 'member' });
      w.svc.workspace.show(c, me.userId, { isMember: true, myRole: 'member' });
      return { c, writer };
    });
    for (const { c, writer } of writers) await writer.post(c.path(), { body: `page ${t}` });
    w.svc.workspace.listPageSize = 1;
    const before = w.svc.workspace.requests.length;
    try {
      const res = await find(me, t);
      expect(res.body.data).toHaveLength(3);
      const asked = w.svc.workspace.requests.slice(before).filter((r) => r.url.includes('/channels?'));
      expect(asked.length).toBeGreaterThanOrEqual(3);
      expect(new Set(asked.map((r) => r.authorization))).toEqual(new Set([`Bearer ${await tokenOf(me)}`]));
    } finally {
      w.svc.workspace.listPageSize = 100;
    }
  });
});

const tokenOf = async (p: Person) => (await import('./support/messaging.js')).tokenFor(p.userId);

describe('filters', () => {
  it('filters by sender, channel, conversation, date and attachment', async () => {
    const ch = new Channel(w);
    const [alice, bob] = [ch.person(), ch.person()];
    const t = word();
    const a1 = (await alice.post(ch.path(), { body: `alpha ${t}` })).body;
    const b1 = (await bob.post(ch.path(), { body: `beta ${t}` })).body;
    expect(bodies(await find(bob, t, `&from=${alice.userId}`))).toEqual([`alpha ${t}`]);
    expect(bodies(await find(bob, t, `&from=${bob.userId}`))).toEqual([`beta ${t}`]);

    await attach(b1.id, ch.chan.orgId, 'doc.txt');
    expect(bodies(await find(alice, t, '&has=file'))).toEqual([`beta ${t}`]);
    expect((await find(alice, t, '&has=file')).body.data[0].attachments).toEqual([
      expect.objectContaining({ name: 'doc.txt', mimeType: 'text/plain', sizeBytes: 12 }),
    ]);

    await db.rows(`UPDATE messaging.messages SET created_at = '2026-01-10T12:00:00Z' WHERE id = $1`, [a1.id]);
    await db.rows(`UPDATE messaging.messages SET created_at = '2026-02-10T12:00:00Z' WHERE id = $1`, [b1.id]);
    expect(bodies(await find(bob, t, '&before=2026-02-01'))).toEqual([`alpha ${t}`]);
    expect(bodies(await find(bob, t, '&after=2026-02-01'))).toEqual([`beta ${t}`]);
    expect(bodies(await find(bob, t, '&after=2026-01-01&before=2026-03-01'))).toEqual([`beta ${t}`, `alpha ${t}`]);
    expect(bodies(await find(bob, t, `&channelId=${ch.chan.chId}`))).toHaveLength(2);

    const orgId = w.newOrg();
    const [x, y] = [w.member(orgId), w.member(orgId)];
    const id = (await x.openDirect(y)).body.id;
    const t2 = word();
    await x.say(id, `dm ${t2}`);
    expect(bodies(await find(asPerson(w, y), t2, `&conversationId=${id}`))).toEqual([`dm ${t2}`]);
    expect(bodies(await find(asPerson(w, y), t2, `&channelId=${ch.chan.chId}`))).toEqual([]);
  });

  it('refuses both channelId and conversationId, and malformed parameters', async () => {
    const ch = new Channel(w);
    const alice = ch.person();
    const both = await find(alice, 'x', `&channelId=${randomUUID()}&conversationId=${randomUUID()}`);
    expect(both.status).toBe(422);
    for (const bad of [
      '&limit=0',
      '&limit=51',
      '&before=yesterday',
      '&has=image',
      '&type=all',
      '&from=nope',
      '&cursor=%%',
    ]) {
      expect((await find(alice, 'x', bad)).status).toBe(422);
    }
    expect((await alice.get(`/api/v1/orgs/${alice.orgId}/message-search`)).status).toBe(422);
    expect((await find(alice, 'x'.repeat(201))).status).toBe(422);
    expect(problemOf(await find(alice, 'x', '&cursor=zzz')).code).toBe('validation_failed');
  });

  it('is closed to non-members of the organization', async () => {
    const stranger = new Person(w, w.newOrg(), randomUUID());
    expect((await find(stranger, 'x')).status).toBe(404);
  });
});

describe('matching', () => {
  it('pages newest first without duplicates or gaps', async () => {
    const ch = new Channel(w);
    const alice = ch.person();
    const t = word();
    const posted: string[] = [];
    for (let i = 0; i < 7; i++) posted.push((await alice.post(ch.path(), { body: `n${i} ${t}` })).body.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await find(alice, t, `&limit=3${cursor ? `&cursor=${enc(cursor)}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.map((m: { id: string }) => m.id));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual([...posted].reverse());
  });

  it('handles websearch syntax: phrases, exclusion, or', async () => {
    const ch = new Channel(w);
    const alice = ch.person();
    const [a, b, c] = [word(), word(), word()];
    await alice.post(ch.path(), { body: `${a} ${b} together` });
    await alice.post(ch.path(), { body: `${b} then ${a}` });
    await alice.post(ch.path(), { body: `${a} only ${c}` });
    expect(bodies(await find(alice, `"${a} ${b}"`))).toEqual([`${a} ${b} together`]);
    expect(bodies(await find(alice, `${a} -${b}`))).toEqual([`${a} only ${c}`]);
    expect(bodies(await find(alice, `${b} or ${c}`))).toHaveLength(3);
    expect((await find(alice, `-${a}`)).body.data).toEqual([]);
    expect((await find(alice, `"`)).status).toBe(200);
    expect((await find(alice, `'; DROP TABLE messaging.messages; --`)).status).toBe(200);
  });

  it('searches attachment names, escaping wildcards, within the same scope', async () => {
    const ch = new Channel(w);
    const [alice, bob] = [ch.person(), ch.person()];
    const t = word();
    const names = [
      `report_${t}.pdf`,
      `reportx${t}.pdf`,
      `100%${t}.txt`,
      `100abc${t}.txt`,
      `back\\${t}.txt`,
      `plain.png`,
    ];
    const ids = [];
    for (const name of names) {
      const m = (await alice.post(ch.path(), { body: `file ${name}` })).body;
      await attach(m.id, ch.chan.orgId, name);
      ids.push(m.id);
    }
    const files = (q: string, extra = '') => find(bob, q, `&type=files${extra}`);
    const named = async (q: string) => (await files(q)).body.data.map((f: { name: string }) => f.name);
    expect(await named(`report_${t}`)).toEqual([`report_${t}.pdf`]);
    expect(await named(`100%${t}`)).toEqual([`100%${t}.txt`]);
    expect(await named('%')).toEqual([`100%${t}.txt`]);
    expect(await named('_')).toEqual([`report_${t}.pdf`]);
    expect(await named(`REPORT`)).toEqual(expect.arrayContaining([`report_${t}.pdf`, `reportx${t}.pdf`]));

    const hit = (await files(`plain`)).body.data.find((f: { name: string }) => f.name === 'plain.png');
    expect(hit).toMatchObject({
      name: 'plain.png',
      mimeType: 'text/plain',
      sizeBytes: 12,
      messageId: ids[5],
      location: { kind: 'channel', workspaceId: ch.chan.wsId, channelId: ch.chan.chId },
    });
    expect(Object.keys(hit).sort()).toEqual([
      'createdAt',
      'fileId',
      'location',
      'messageId',
      'mimeType',
      'name',
      'sizeBytes',
    ]);

    const first = await files('.', '&limit=2');
    expect(first.body.data).toHaveLength(2);
    const second = await files('.', `&limit=2&cursor=${enc(first.body.nextCursor)}`);
    expect(second.body.data.map((f: { fileId: string }) => f.fileId)).not.toEqual(
      expect.arrayContaining(first.body.data.map((f: { fileId: string }) => f.fileId)),
    );

    ch.hide(bob);
    expect((await files(`report_${t}`)).body).toEqual({ data: [], nextCursor: null });
  });

  it('does not reveal anything through shape: scoped-out and empty answers are identical', async () => {
    const ch = new Channel(w);
    const [alice, bob] = [ch.person(), ch.person()];
    const t = word();
    await alice.post(ch.path(), { body: `private ${t}` });
    ch.hide(bob);
    const hidden = await find(bob, t);
    const empty = await find(bob, word());
    expect(hidden.body).toEqual(empty.body);
    expect(Object.keys(hidden.body)).toEqual(['data', 'nextCursor']);
    expect(hidden.headers['x-total-count']).toBeUndefined();
    const files = await find(bob, t, '&type=files');
    expect(files.body).toEqual(empty.body);
  });
});
