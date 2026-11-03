// Supertest response bodies are untyped JSON; the assertions below read them directly.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asPerson, Channel, makePlace, type Place } from './support/collab.js';
import { startCollabWithFiles, type FilesCollab } from './support/files.js';
import { db, problemOf } from './support/messaging.js';

let w: FilesCollab;
beforeAll(async () => {
  w = await startCollabWithFiles();
});
afterAll(async () => {
  await w.close();
});

const attachmentRows = (messageId: string) =>
  db.rows<{ file_id: string; position: number; name: string; mime_type: string; size_bytes: string }>(
    'SELECT file_id, position, name, mime_type, size_bytes FROM messaging.message_attachments WHERE message_id = $1 ORDER BY position',
    [messageId],
  );
const accessPath = (orgId: string, fileId: string) => `/api/v1/orgs/${orgId}/attachments/${fileId}`;

describe.each(['channel', 'group'] as const)('attachments on posts in a %s', (kind) => {
  let p: Place;
  beforeAll(async () => {
    p = await makePlace(w, kind);
  });
  const orgId = () => p.alice.orgId;

  it('attaches my own available files in order, with a snapshot of their metadata', async () => {
    const a = w.files.add(orgId(), p.alice.userId, { name: 'plan.pdf', mimeType: 'application/pdf', sizeBytes: 10 });
    const b = w.files.add(orgId(), p.alice.userId, {
      name: 'pic.png',
      mimeType: 'image/png',
      sizeBytes: 5_000_000_000,
    });
    const res = await p.alice.post(p.path(), { body: 'see these', attachmentFileIds: [b, a] });
    expect(res.status).toBe(201);
    expect(res.body.attachments).toEqual([
      { fileId: b, name: 'pic.png', mimeType: 'image/png', sizeBytes: 5_000_000_000 },
      { fileId: a, name: 'plan.pdf', mimeType: 'application/pdf', sizeBytes: 10 },
    ]);
    const rows = await attachmentRows(res.body.id);
    expect(rows.map((r) => [r.file_id, r.position, r.name])).toEqual([
      [b, 0, 'pic.png'],
      [a, 1, 'plan.pdf'],
    ]);
    // Asked as the caller, with their own token.
    expect(w.files.requests.at(-1)!.caller).toBe(p.alice.userId);
    // Listed for everyone who can read the place, and a plain message has none.
    const plain = (await p.alice.post(p.path(), { body: 'no files' })).body;
    expect(plain.attachments).toEqual([]);
    const listed = (await p.bob.get(p.path())).body.data;
    expect(listed.find((m: { id: string }) => m.id === res.body.id).attachments).toHaveLength(2);
    expect(listed.find((m: { id: string }) => m.id === plain.id).attachments).toEqual([]);
  });

  it('accepts an empty or missing body only together with attachments', async () => {
    const f = w.files.add(orgId(), p.alice.userId);
    const empty = await p.alice.post(p.path(), { body: '', attachmentFileIds: [f] });
    expect(empty.status).toBe(201);
    expect(empty.body.body).toBe('');
    const g = w.files.add(orgId(), p.alice.userId);
    const missing = await p.alice.post(p.path(), { attachmentFileIds: [g] });
    expect(missing.status).toBe(201);
    expect(missing.body.body).toBe('');

    for (const body of [
      { body: '' },
      { body: '   ' },
      {},
      { body: '', attachmentFileIds: [] },
      { attachmentFileIds: [] },
    ]) {
      const res = await p.alice.post(p.path(), body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect((await p.alice.post(p.path(), { body: 5, attachmentFileIds: [f] })).status).toBe(422);
  });

  it('refuses files that are not mine, not available, or missing (422) and creates nothing', async () => {
    const before = await db.count(
      'SELECT count(*) AS n FROM messaging.message_attachments WHERE organization_id = $1',
      [orgId()],
    );
    const mine = w.files.add(orgId(), p.alice.userId);
    const bobs = w.files.add(orgId(), p.bob.userId);
    const pending = w.files.add(orgId(), p.alice.userId, { status: 'pending_upload' });
    const deleted = w.files.add(orgId(), p.alice.userId, { status: 'deleted' });
    const foreignOrg = w.files.add(randomUUID(), p.alice.userId);
    for (const bad of [bobs, pending, deleted, randomUUID(), foreignOrg]) {
      const res = await p.alice.post(p.path(), { body: 'x', attachmentFileIds: [mine, bad] });
      expect(res.status).toBe(422);
      expect(problemOf(res).errors?.[0]?.code).toBe('invalid_attachment');
    }
    // The answer is the same whether the file exists, belongs to someone else, or is pending.
    const [a, b] = await Promise.all(
      [bobs, randomUUID()].map((id) => p.alice.post(p.path(), { body: 'x', attachmentFileIds: [id] })),
    );
    expect(a!.body).toEqual({ ...b!.body, instance: a!.body.instance, requestId: a!.body.requestId });
    expect(
      await db.count('SELECT count(*) AS n FROM messaging.message_attachments WHERE organization_id = $1', [orgId()]),
    ).toBe(before);
    expect(JSON.stringify((await p.alice.get(p.path())).body)).not.toContain('"x"');
  });

  it('allows at most 10 distinct attachments', async () => {
    const ids = Array.from({ length: 11 }, () => w.files.add(orgId(), p.alice.userId));
    expect((await p.alice.post(p.path(), { body: 'ten', attachmentFileIds: ids.slice(0, 10) })).status).toBe(201);
    expect((await p.alice.post(p.path(), { body: 'eleven', attachmentFileIds: ids })).status).toBe(422);
    expect((await p.alice.post(p.path(), { body: 'dup', attachmentFileIds: [ids[0], ids[0]] })).status).toBe(422);
    expect(
      (await p.alice.post(p.path(), { body: 'dup', attachmentFileIds: [ids[0], ids[0]!.toUpperCase()] })).status,
    ).toBe(422);
    expect((await p.alice.post(p.path(), { body: 'bad', attachmentFileIds: ['nope'] })).status).toBe(422);
    expect((await p.alice.post(p.path(), { body: 'bad', attachmentFileIds: 'nope' })).status).toBe(422);
  });

  it('attaches to a thread reply', async () => {
    const root = (await p.alice.post(p.path(), { body: 'root' })).body;
    const f = w.files.add(orgId(), p.bob.userId);
    const reply = await p.bob.post(p.path(), { body: '', threadRootId: root.id, attachmentFileIds: [f] });
    expect(reply.status).toBe(201);
    expect(reply.body.attachments).toHaveLength(1);
    const replies = (await p.alice.get(p.path(`/${root.id}/replies`))).body.data;
    expect(replies[0].attachments[0].fileId).toBe(f);
  });

  it('replays a clientMessageId with the original message and its attachments', async () => {
    const f = w.files.add(orgId(), p.alice.userId, { name: 'once.txt', mimeType: 'text/plain' });
    const body = { body: 'once', clientMessageId: 'attach-1', attachmentFileIds: [f] };
    const first = await p.alice.post(p.path(), body);
    const again = await p.alice.post(p.path(), body);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.attachments).toEqual(first.body.attachments);
    expect(await attachmentRows(first.body.id)).toHaveLength(1);
  });

  it('answers 503 when the files service fails, and posts nothing', async () => {
    const f = w.files.add(orgId(), p.alice.userId);
    w.files.failing = true;
    try {
      const res = await p.alice.post(p.path(), { body: 'while down', attachmentFileIds: [f] });
      expect(res.status).toBe(503);
      expect(problemOf(res).code).toBe('dependency_unavailable');
      // Posts without attachments never ask the files service.
      expect((await p.alice.post(p.path(), { body: 'fine' })).status).toBe(201);
    } finally {
      w.files.failing = false;
    }
    const listed = (await p.alice.get(p.path())).body.data;
    expect(listed.some((m: { body: string }) => m.body === 'while down')).toBe(false);
  });

  it('deletes the attachment rows with the message, in the same step', async () => {
    const f = w.files.add(orgId(), p.alice.userId);
    const m = (await p.alice.post(p.path(), { body: 'gone soon', attachmentFileIds: [f] })).body;
    expect(await attachmentRows(m.id)).toHaveLength(1);
    expect((await p.alice.delete(p.path(`/${m.id}`))).status).toBe(204);
    expect(await attachmentRows(m.id)).toHaveLength(0);
    const listed = (await p.bob.get(p.path())).body.data.find((x: { id: string }) => x.id === m.id);
    expect(listed).toMatchObject({ deletedAt: expect.any(String), body: null, attachments: [] });
  });
});

describe('who may see an attached file (GET /orgs/{o}/attachments/{fileId})', () => {
  it('channel: a reader of a public channel sees it, someone without access does not, admins do not bypass', async () => {
    const channel = new Channel(w);
    const [alice, reader] = [channel.person(), channel.person('reader')];
    const outsider = channel.person();
    channel.hide(outsider);
    // An admin of another channel in the same organization is no exception.
    const other = Object.assign(new Channel(w), { chan: new Channel(w).chan.inOrg(channel.chan.orgId) });
    const admin = other.person('admin');
    w.org.addMember(channel.chan.orgId, admin.userId);
    const f = w.files.add(channel.chan.orgId, alice.userId);
    await alice.post(channel.path(), { body: 'file', attachmentFileIds: [f] });
    const orgId = channel.chan.orgId;

    for (const who of [alice, reader]) {
      const res = await who.get(accessPath(orgId, f));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ fileId: f });
    }
    expect((await outsider.get(accessPath(orgId, f))).status).toBe(404);
    expect((await asPerson(w, w.member(orgId)).get(accessPath(orgId, f))).status).toBe(404);
    expect((await new Channel(w).person().get(accessPath(orgId, f))).status).toBe(404);
    expect((await alice.get(accessPath(orgId, randomUUID()))).status).toBe(404);
    expect((await alice.get(accessPath(orgId, 'not-a-uuid'))).status).toBe(404);
  });

  it('channel: a hidden private channel gives 404 again, and the workspace is asked once (the visible-channels list)', async () => {
    const [one, two] = [new Channel(w), new Channel(w)];
    const orgId = one.chan.orgId;
    const second = Object.assign(two, { chan: two.chan.inOrg(orgId) });
    const alice = one.person();
    w.svc.workspace.show(second.chan, alice.userId, { isMember: true, myRole: 'member' });
    const f = w.files.add(orgId, alice.userId);
    for (const c of [one, one, second]) await alice.post(c.path(), { body: 'again', attachmentFileIds: [f] });

    w.svc.workspace.hide(one.chan, alice.userId);
    w.svc.workspace.hide(second.chan, alice.userId);
    const before = w.svc.workspace.requests.length;
    expect((await alice.get(accessPath(orgId, f))).status).toBe(404);
    const calls = w.svc.workspace.requests.slice(before);
    expect(calls).toHaveLength(1);
    expect(calls.every((c) => c.authorization?.startsWith('Bearer '))).toBe(true);

    // One visible channel is enough.
    w.svc.workspace.show(one.chan, alice.userId, { isMember: false, myRole: null });
    expect((await alice.get(accessPath(orgId, f))).status).toBe(200);
    // The workspace service failing is not "no": 503.
    w.svc.workspace.hide(one.chan, alice.userId);
    w.svc.workspace.listFailure = 'error';
    try {
      expect((await alice.get(accessPath(orgId, f))).status).toBe(503);
    } finally {
      w.svc.workspace.listFailure = null;
    }
  });

  it('conversation: participants see it, non-participants and strangers do not, history starts at the join', async () => {
    const orgId = w.newOrg();
    const [alice, bob, carol, dave, eve] = [1, 2, 3, 4, 5].map(() => w.member(orgId)) as [
      ReturnType<typeof w.member>,
      ReturnType<typeof w.member>,
      ReturnType<typeof w.member>,
      ReturnType<typeof w.member>,
      ReturnType<typeof w.member>,
    ];
    const id = await alice.group([bob, carol]);
    const f = w.files.add(orgId, alice.userId);
    const posted = await alice.post(`/${id}/messages`, { body: 'group file', attachmentFileIds: [f] });
    expect(posted.status).toBe(201);

    expect((await asPerson(w, alice).get(accessPath(orgId, f))).status).toBe(200);
    expect((await asPerson(w, bob).get(accessPath(orgId, f))).status).toBe(200);
    expect((await asPerson(w, eve).get(accessPath(orgId, f))).status).toBe(404);
    // Another organization's member, and the same person on another organization's path.
    const foreign = asPerson(w, w.member(w.newOrg()));
    expect((await foreign.get(accessPath(orgId, f))).status).toBe(404);
    expect((await asPerson(w, bob).get(accessPath(w.newOrg(), f))).status).toBe(404);

    // Dave joins later: the earlier message, and its file, stay hidden from him.
    expect((await alice.put(`/${id}/participants/${dave.userId}`, {})).status).toBeLessThan(300);
    expect((await asPerson(w, dave).get(accessPath(orgId, f))).status).toBe(404);
    // A file attached after the join is his to see.
    const later = w.files.add(orgId, alice.userId);
    await alice.post(`/${id}/messages`, { body: 'new file', attachmentFileIds: [later] });
    expect((await asPerson(w, dave).get(accessPath(orgId, later))).status).toBe(200);
    // Removed participants lose it.
    await alice.delete(`/${id}/participants/${bob.userId}`);
    expect((await asPerson(w, bob).get(accessPath(orgId, f))).status).toBe(404);
  });

  it('a deleted message no longer grants access; another message with the file still does', async () => {
    const p = await makePlace(w, 'group');
    const orgId = p.alice.orgId;
    const f = w.files.add(orgId, p.alice.userId);
    const first = (await p.alice.post(p.path(), { body: 'one', attachmentFileIds: [f] })).body;
    const second = (await p.alice.post(p.path(), { body: 'two', attachmentFileIds: [f] })).body;
    expect((await p.bob.get(accessPath(orgId, f))).status).toBe(200);
    await p.alice.delete(p.path(`/${first.id}`));
    expect((await p.bob.get(accessPath(orgId, f))).status).toBe(200);
    await p.alice.delete(p.path(`/${second.id}`));
    expect((await p.bob.get(accessPath(orgId, f))).status).toBe(404);
    expect((await p.alice.get(accessPath(orgId, f))).status).toBe(404);
  });

  it('a reply of a deleted thread root no longer grants access', async () => {
    const p = await makePlace(w, 'group');
    const orgId = p.alice.orgId;
    const root = (await p.alice.post(p.path(), { body: 'root' })).body;
    const f = w.files.add(orgId, p.alice.userId);
    await p.alice.post(p.path(), { body: 'reply', threadRootId: root.id, attachmentFileIds: [f] });
    expect((await p.bob.get(accessPath(orgId, f))).status).toBe(200);
    await p.alice.delete(p.path(`/${root.id}`));
    expect((await p.bob.get(accessPath(orgId, f))).status).toBe(404);
  });

  it('requires authentication and is closed to a missing token', async () => {
    const p = await makePlace(w, 'group');
    const f = w.files.add(p.alice.orgId, p.alice.userId);
    const res = await (await import('supertest')).default(w.svc.server).get(accessPath(p.alice.orgId, f));
    expect(res.status).toBe(401);
  });
});

describe('the files service being unreachable', () => {
  it('is a 503, never an implicit yes (run last: it closes the fake)', async () => {
    const p = await makePlace(w, 'channel');
    const f = w.files.add(p.alice.orgId, p.alice.userId);
    await w.files.close();
    const res = await p.alice.post(p.path(), { body: 'nowhere', attachmentFileIds: [f] });
    expect(res.status).toBe(503);
    expect(problemOf(res).code).toBe('dependency_unavailable');
  });
});
