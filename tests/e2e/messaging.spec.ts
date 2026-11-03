import { createWorkspace, expect, joinWorkspace, orgOf, test } from './support/fixtures.js';

test('posts, edits and deletes a channel message (a tombstone remains)', async ({ browser }) => {
  const { owner, org } = await orgOf(browser, 'Mara');
  const workspace = await createWorkspace(owner, org);
  const page = owner.page;
  await page.goto(`/o/${org.slug}/w/${workspace.id}/c/${workspace.generalId}`);
  const log = page.getByRole('log', { name: 'Messages in #general' });
  await expect(log.getByText('No messages yet.')).toBeVisible();

  await page.getByRole('textbox', { name: 'Message #general' }).fill('hello from the browser');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(log.getByText('hello from the browser')).toBeVisible();
  await expect(log.getByText('Sending…')).toHaveCount(0);

  // Enter sends too, Shift+Enter adds a line.
  await page.getByRole('textbox', { name: 'Message #general' }).fill('second');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('line');
  await page.keyboard.press('Enter');
  await expect(log.getByText(/second\s+line/)).toBeVisible();

  await log
    .getByRole('listitem')
    .filter({ hasText: 'hello from the browser' })
    .getByRole('button', { name: 'Message actions' })
    .click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await log.getByRole('textbox', { name: 'Edit message' }).fill('hello, edited');
  await log.getByRole('button', { name: 'Save' }).click();
  await expect(log.getByText('hello, edited')).toBeVisible();
  await expect(log.getByText('hello from the browser')).toHaveCount(0);
  const message = log.getByRole('listitem').filter({ hasText: 'hello, edited' });
  await expect(message.getByText('(edited)')).toBeVisible();

  await message.getByRole('button', { name: 'Message actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete message' }).click();
  await expect(log.getByText('Message deleted')).toBeVisible();
  await expect(log.getByText('hello, edited')).toHaveCount(0);

  // The tombstone and the other message survive a reload.
  await page.reload();
  await expect(log.getByText('Message deleted')).toBeVisible();
  await expect(log.getByText(/second\s+line/)).toBeVisible();
});

test('a message appears for another person without a reload (realtime)', async ({ browser }) => {
  const {
    owner,
    org,
    members: [reader],
  } = await orgOf(browser, 'Rhea', 'Remy');
  const workspace = await createWorkspace(owner, org);
  await joinWorkspace(reader!, org, workspace);
  const url = `/o/${org.slug}/w/${workspace.id}/c/${workspace.generalId}`;

  // The reader's browser must hold a live realtime connection before anything is posted.
  const sockets: { url: string; frames: number; closed: () => boolean }[] = [];
  reader!.page.on('websocket', (ws) => {
    if (!ws.url().includes('/realtime/')) return;
    const socket = { url: ws.url(), frames: 0, closed: () => ws.isClosed() };
    ws.on('framereceived', () => (socket.frames += 1));
    sockets.push(socket);
  });
  await reader!.page.goto(url);
  const reads = reader!.page.getByRole('log', { name: 'Messages in #general' });
  await reads.waitFor();
  await expect.poll(() => sockets.some((socket) => !socket.closed() && socket.frames > 0)).toBe(true);
  await owner.page.goto(url);
  await expect(owner.page.getByRole('textbox', { name: 'Message #general' })).toBeVisible();
  await reader!.page.waitForTimeout(1_000); // let the subscription settle before anything is posted

  const latencies: number[] = [];
  for (const body of ['realtime one', 'realtime two', 'realtime three']) {
    await owner.page.getByRole('textbox', { name: 'Message #general' }).fill(body);
    const sent = Date.now();
    await owner.page.getByRole('button', { name: 'Send message' }).click();
    await expect(reads.getByText(body)).toBeVisible({ timeout: 4_000 });
    latencies.push(Date.now() - sent);
  }
  console.log(`[realtime] latency to the other browser, no reload: ${latencies.join(' ms, ')} ms`);
  test.info().annotations.push({ type: 'realtime-latency-ms', description: latencies.join(',') });

  // Edits and deletions reach the reader live too.
  await owner.page
    .getByRole('listitem')
    .filter({ hasText: 'realtime one' })
    .getByRole('button', { name: 'Message actions' })
    .click();
  await owner.page.getByRole('menuitem', { name: 'Delete' }).click();
  await owner.page.getByRole('dialog').getByRole('button', { name: 'Delete message' }).click();
  await expect(reads.getByText('realtime one')).toHaveCount(0, { timeout: 4_000 });
  const live = sockets.find((socket) => !socket.closed() && socket.frames > 0);
  console.log(`[realtime] socket ${live?.url} open, ${live?.frames} frames received by the reader`);
  expect(live).toBeDefined();
});
