import { channelOf } from './support/channel.js';
import { call, expect, test, type Person } from './support/fixtures.js';

const messageActions = (log: ReturnType<Person['page']['getByRole']>, text: string | RegExp) =>
  log.getByRole('listitem').filter({ hasText: text }).getByRole('button', { name: 'Message actions' });

test('replies in a thread from the thread panel and shows the reply count', async ({ browser }) => {
  const { owner, url, post } = await channelOf(browser, 'Thea');
  await post(owner, 'what do we ship first?');
  const page = owner.page;
  await page.goto(url);
  const log = page.getByRole('log', { name: 'Messages in #general' });
  await expect(log.getByText('what do we ship first?')).toBeVisible();

  await messageActions(log, 'what do we ship first?').click();
  await page.getByRole('menuitem', { name: 'Reply in thread' }).click();
  const panel = page.getByRole('complementary', { name: 'Thread' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('No replies yet.')).toBeVisible();

  await panel.getByRole('textbox', { name: 'Reply in thread' }).fill('the files page');
  await panel.getByRole('button', { name: 'Send message' }).click();
  await expect(panel.getByRole('list', { name: 'Replies' }).getByText('the files page')).toBeVisible();

  // The timeline shows the count on the root; the reply itself stays out of the channel timeline.
  await panel.getByRole('button', { name: 'Close thread' }).click();
  await expect(panel).toHaveCount(0);
  await expect(log.getByRole('button', { name: /^1 reply/ })).toBeVisible();
  await expect(log.getByText('the files page')).toHaveCount(0);
  await page.reload();
  await expect(log.getByRole('button', { name: /^1 reply/ })).toBeVisible();
});

test('a reaction appears live for another person, and taking it back removes it', async ({ browser }) => {
  const {
    owner,
    members: [reader],
    url,
    post,
  } = await channelOf(browser, 'Rhea', 'Remy');
  await post(owner, 'ship it');

  const sockets: { frames: number; closed: () => boolean }[] = [];
  reader!.page.on('websocket', (ws) => {
    if (!ws.url().includes('/realtime/')) return;
    const socket = { frames: 0, closed: () => ws.isClosed() };
    ws.on('framereceived', () => (socket.frames += 1));
    sockets.push(socket);
  });
  await reader!.page.goto(url);
  const reads = reader!.page.getByRole('log', { name: 'Messages in #general' });
  await expect(reads.getByText('ship it')).toBeVisible();
  await expect.poll(() => sockets.some((socket) => !socket.closed() && socket.frames > 0)).toBe(true);
  await owner.page.goto(url);
  const writes = owner.page.getByRole('log', { name: 'Messages in #general' });
  await expect(writes.getByText('ship it')).toBeVisible();
  await reader!.page.waitForTimeout(1_000); // let the subscription settle

  await messageActions(writes, 'ship it').click();
  await owner.page.getByRole('menuitem', { name: 'Add reaction' }).click();
  await owner.page.getByRole('menuitem', { name: 'React with rocket' }).click();
  const mine = writes.getByRole('button', { name: '🚀 1 reaction, including yours' });
  await expect(mine).toHaveAttribute('aria-pressed', 'true');
  await expect(reads.getByRole('button', { name: '🚀 1 reaction' })).toBeVisible({ timeout: 5_000 });

  await mine.click();
  await expect(reads.getByRole('button', { name: /🚀/ })).toHaveCount(0, { timeout: 5_000 });
});

test('mentions a person from the autocomplete and renders a chip', async ({ browser }) => {
  const {
    owner,
    members: [mentioned],
    url,
    base,
  } = await channelOf(browser, 'Mara', 'Quentin');
  const page = owner.page;
  await page.goto(url);
  const box = page.getByRole('textbox', { name: 'Message #general' });
  await box.click();
  await page.keyboard.type('hello @Quen');
  const list = page.getByRole('listbox', { name: 'People to mention' });
  await expect(list.getByRole('option', { name: 'Quentin' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(box).toHaveValue('hello @Quentin ');
  await page.keyboard.type('welcome');
  await page.getByRole('button', { name: 'Send message' }).click();

  const log = page.getByRole('log', { name: 'Messages in #general' });
  const message = log.getByRole('listitem').filter({ hasText: 'welcome' });
  await expect(message.getByText('@Quentin', { exact: true })).toBeVisible();
  // On the wire the mention is a token for the person, not their name.
  await expect(log.getByText('Sending…')).toHaveCount(0);
  await expect
    .poll(async () => {
      const { data } = await call<{ data: { body: string | null }[] }>(owner, 'get', `${base}/messages`);
      return data.some((m) => m.body?.includes(`<@${mentioned!.userId}>`));
    })
    .toBe(true);
});

test('saves a message from the actions menu and finds it on the Saved page', async ({ browser }) => {
  const { owner, org, url, post } = await channelOf(browser, 'Sven');
  await post(owner, 'remember the offsite budget');
  const page = owner.page;
  await page.goto(url);
  const log = page.getByRole('log', { name: 'Messages in #general' });
  await messageActions(log, 'remember the offsite budget').click();
  await page.getByRole('menuitem', { name: 'Save message' }).click();

  await page.goto(`/o/${org.slug}/saved`);
  const saved = page.getByRole('list', { name: 'Saved messages' });
  await expect(saved.getByText('remember the offsite budget')).toBeVisible();

  await saved.getByRole('button', { name: /Remove|Unsave/ }).click();
  await expect(page.getByText('Nothing saved yet')).toBeVisible();
});

test('renders bold and code blocks, and never makes a javascript: link clickable', async ({ browser }) => {
  const { owner, url, post } = await channelOf(browser, 'Fay');
  await post(
    owner,
    [
      '**bold move** and _slanted_',
      '```',
      'const answer = 42;',
      '```',
      'javascript:alert(1) https://example.com/docs',
    ].join('\n'),
  );
  const page = owner.page;
  let dialogs = 0;
  page.on('dialog', (dialog) => {
    dialogs += 1;
    void dialog.dismiss();
  });
  await page.goto(url);
  const log = page.getByRole('log', { name: 'Messages in #general' });
  await expect(log.locator('strong', { hasText: 'bold move' })).toBeVisible();
  await expect(log.locator('em', { hasText: 'slanted' })).toBeVisible();
  await expect(log.locator('pre code')).toHaveText('const answer = 42;');

  await expect(log.getByText('javascript:alert(1)', { exact: false })).toBeVisible();
  await expect(log.locator('a[href^="javascript:" i]')).toHaveCount(0);
  const links = log.getByRole('link');
  await expect(links).toHaveCount(1);
  await expect(links.first()).toHaveAttribute('href', 'https://example.com/docs');
  await expect(links.first()).toHaveAttribute('rel', /noopener/);

  await log.getByText('javascript:alert(1)', { exact: false }).click();
  expect(dialogs).toBe(0);
});
