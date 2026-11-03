import type { Page } from '@playwright/test';
import { channelOf, uploadFile } from './support/channel.js';
import { call, createWorkspace, expect, newContext, orgOf, test } from './support/fixtures.js';

const PHONE = { width: 390, height: 844 };
const overflowFree = (page: Page) => page.evaluate('document.documentElement.scrollWidth <= window.innerWidth');

test('at phone width key pages have no horizontal overflow and the menu navigates', async ({ browser }) => {
  // One test visits about 15 pages; under a loaded machine that alone can exceed the default 60 s budget.
  test.setTimeout(180_000);
  const { owner, org } = await orgOf(browser, 'Pia');
  const workspace = await createWorkspace(owner, org, 'Atlas');
  const long = 'a-very-long-unbroken-message-body-'.repeat(8);
  await call(owner, 'post', `/orgs/${org.id}/workspaces/${workspace.id}/channels/${workspace.generalId}/messages`, {
    body: long,
  });
  const dept = await call<{ id: string }>(owner, 'post', `/orgs/${org.id}/departments`, { name: 'Engineering' });
  await call(owner, 'post', `/orgs/${org.id}/teams`, { name: 'Platform', departmentId: dept.id, visibility: 'public' });

  // Public pages first.
  const anonymous = await (await newContext(browser)).newPage();
  await anonymous.setViewportSize(PHONE);
  for (const path of ['/login', '/register']) {
    await anonymous.goto(path);
    await expect(anonymous.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await overflowFree(anonymous), `${path} overflows`).toBe(true);
  }

  const page = owner.page;
  await page.setViewportSize(PHONE);
  const base = `/o/${org.slug}`;
  for (const path of [
    base,
    `${base}/workspaces`,
    `${base}/w/${workspace.id}`,
    `${base}/w/${workspace.id}/c/${workspace.generalId}`,
    `${base}/w/${workspace.id}/settings`,
    `${base}/members`,
    `${base}/invitations`,
    `${base}/departments`,
    `${base}/teams`,
    `${base}/settings`,
    `${base}/messages`,
    '/account/sessions',
    '/account/password',
  ]) {
    await page.goto(path);
    await expect(page.getByRole('main')).toBeVisible();
    await page.waitForTimeout(600);
    expect(await overflowFree(page), `${path} overflows at ${PHONE.width}px`).toBe(true);
  }

  // The desktop sidebar is replaced by a menu button.
  await page.goto(base);
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeHidden();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const menu = page.getByRole('dialog', { name: 'Navigation' });
  await expect(menu).toBeVisible();
  await menu.getByRole('link', { name: 'Members' }).click();
  await expect(page).toHaveURL(new RegExp(`${base}/members$`));
  await expect(menu).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Members', level: 2 })).toBeVisible();

  // Channels are reachable from the menu inside a workspace.
  await page.goto(`${base}/w/${workspace.id}`);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page
    .getByRole('dialog', { name: 'Navigation' })
    .getByRole('navigation', { name: 'Channels' })
    .getByRole('link', { name: 'general' })
    .click();
  await expect(page.getByRole('log', { name: 'Messages in #general' })).toBeVisible();
  expect(await overflowFree(page)).toBe(true);
});

test('at phone width the new pages do not overflow and the thread and context panels are usable', async ({
  browser,
}) => {
  const {
    owner,
    org,
    members: [ben],
    url,
    post,
  } = await channelOf(browser, 'Pax', 'Bo');
  const root = await post(owner, 'zebra planning thread');
  await post(ben!, `a reply mentioning <@${owner.userId}>`, { threadRootId: root.id });
  const hit = await post(ben!, `zebra ${'unbroken-'.repeat(20)} <@${owner.userId}>`);
  const fileId = await uploadFile(owner, org.id, `zebra-${'long-name-'.repeat(8)}.txt`, Buffer.from('notes'));
  await post(owner, 'with a file', { attachmentFileIds: [fileId] });

  const page = owner.page;
  await page.setViewportSize(PHONE);
  const base = `/o/${org.slug}`;
  for (const path of [`${base}/files`, `${base}/search?q=zebra`, `${base}/activity`, `${base}/saved`, url]) {
    await page.goto(path);
    await expect(page.getByRole('main')).toBeVisible();
    await page.waitForTimeout(600);
    expect(await overflowFree(page), `${path} overflows at ${PHONE.width}px`).toBe(true);
  }

  // The context panel fits the screen, shows the target and closes.
  await page.goto(`${url}?message=${hit.id}`);
  const context = page.getByRole('complementary', { name: 'Message in context' });
  await expect(context.locator('[data-highlight]')).toBeVisible();
  await page.waitForTimeout(600);
  const box = (await context.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
  expect(await overflowFree(page)).toBe(true);
  await context.getByRole('button', { name: 'Jump to latest' }).click();
  await expect(context).toHaveCount(0);

  // The thread panel fits, takes a reply and closes.
  await page.goto(url);
  const log = page.getByRole('log', { name: 'Messages in #general' });
  await log
    .getByRole('listitem')
    .filter({ hasText: 'zebra planning thread' })
    .getByRole('button', { name: 'Message actions' })
    .click();
  await page.getByRole('menuitem', { name: 'Reply in thread' }).click();
  const thread = page.getByRole('complementary', { name: 'Thread' });
  await expect(thread.getByText(/a reply mentioning/)).toBeVisible();
  await page.waitForTimeout(600);
  const threadBox = (await thread.boundingBox())!;
  expect(threadBox.x).toBeGreaterThanOrEqual(0);
  expect(threadBox.x + threadBox.width).toBeLessThanOrEqual(PHONE.width);
  expect(await overflowFree(page)).toBe(true);
  await thread.getByRole('textbox', { name: 'Reply in thread' }).fill('replying from a phone');
  await thread.getByRole('button', { name: 'Send message' }).click();
  await expect(thread.getByRole('list', { name: 'Replies' }).getByText('replying from a phone')).toBeVisible();
  await thread.getByRole('button', { name: 'Close thread' }).click();
  await expect(thread).toHaveCount(0);
});
