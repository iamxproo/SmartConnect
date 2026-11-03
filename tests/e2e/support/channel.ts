// A channel with people in it, plus the setup helpers the messaging specs share (files, sockets).
import type { Browser, Page } from '@playwright/test';
import { call, createWorkspace, joinWorkspace, orgOf, type Person } from './fixtures.js';

/** A founder, members who joined the organization and a workspace, and its #general channel. */
export async function channelOf(browser: Browser, founder: string, ...members: string[]) {
  const setup = await orgOf(browser, founder, ...members);
  const workspace = await createWorkspace(setup.owner, setup.org);
  for (const member of setup.members) await joinWorkspace(member, setup.org, workspace);
  const workspaceBase = `/orgs/${setup.org.id}/workspaces/${workspace.id}`;
  const base = `${workspaceBase}/channels/${workspace.generalId}`;
  const url = `/o/${setup.org.slug}/w/${workspace.id}/c/${workspace.generalId}`;
  const post = (who: Person, body: string, extra: Record<string, unknown> = {}) =>
    call<{ id: string }>(who, 'post', `${base}/messages`, { body, ...extra });
  return { ...setup, workspace, workspaceBase, base, url, post };
}

/** A private channel the founder created, with `members` added to it. Returns its API base and page address. */
export async function privateChannel(setup: Awaited<ReturnType<typeof channelOf>>, name: string, ...members: Person[]) {
  const { id } = await call<{ id: string }>(setup.owner, 'post', `${setup.workspaceBase}/channels`, {
    name,
    type: 'private',
  });
  const base = `${setup.workspaceBase}/channels/${id}`;
  for (const member of members) await call(setup.owner, 'put', `${base}/members/${member.userId}`, {});
  return { id, base, url: `/o/${setup.org.slug}/w/${setup.workspace.id}/c/${id}` };
}

/** Uploads a file through the API (the same two calls the web app makes) and returns its id. */
export async function uploadFile(who: Person, orgId: string, name: string, bytes: Buffer): Promise<string> {
  const { id } = await call<{ id: string }>(who, 'post', `/orgs/${orgId}/files`, { name, sizeBytes: bytes.length });
  const res = await who.api.put(`/api/v1/orgs/${orgId}/files/${id}/content`, {
    headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'application/octet-stream' },
    data: bytes,
  });
  if (res.status() !== 200) throw new Error(`upload answered ${res.status()}: ${await res.text()}`);
  return id;
}

/** Resolves once the page's realtime socket has received a frame, so a later live update cannot be missed. */
export function watchRealtime(page: Page): () => Promise<void> {
  let frames = 0;
  page.on('websocket', (ws) => {
    if (ws.url().includes('/realtime/')) ws.on('framereceived', () => (frames += 1));
  });
  return async () => {
    for (let i = 0; i < 50 && frames === 0; i++) await page.waitForTimeout(100);
    if (frames === 0) throw new Error('the realtime socket received nothing');
  };
}

// A real 1x1 PNG: the files service detects the type from the bytes, and only a PNG, JPEG, GIF or WebP previews.
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
