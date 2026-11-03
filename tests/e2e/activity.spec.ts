import type { Page } from '@playwright/test';
import { channelOf } from './support/channel.js';
import { call, expect, test } from './support/fixtures.js';

const bell = (page: Page, name: string | RegExp) => page.getByRole('link', { name, exact: typeof name === 'string' });

test('a mention raises the bell, opens in context and is marked read; Mark all as read clears the rest', async ({
  browser,
}) => {
  const {
    owner,
    org,
    members: [bea],
    url,
    post,
  } = await channelOf(browser, 'Alma', 'Bea');
  await post(owner, `hello <@${bea!.userId}> please review the budget`);
  const page = bea!.page;
  await page.goto(`/o/${org.slug}`);
  await expect(bell(page, 'Activity, 1 unread')).toBeVisible({ timeout: 15_000 });

  await bell(page, 'Activity, 1 unread').click();
  const list = page.getByRole('list', { name: 'Activity' });
  const item = list.getByRole('link', { name: /Alma mentioned you/ });
  await expect(item).toContainText('please review the budget');
  await expect(item).toContainText('(unread)');

  await item.click();
  await expect(page).toHaveURL(new RegExp(`${url}\\?message=`));
  await expect(
    page.getByRole('complementary', { name: 'Message in context' }).locator('[data-highlight]'),
  ).toContainText('please review the budget');
  await expect(bell(page, 'Activity')).toBeVisible();

  await post(owner, `second ping <@${bea!.userId}>`);
  await post(owner, `third ping <@${bea!.userId}>`);
  await page.goto(`/o/${org.slug}/activity`);
  await expect(list.getByRole('link')).toHaveCount(3);
  await expect(bell(page, 'Activity, 2 unread')).toBeVisible();
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(bell(page, 'Activity')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark all as read' })).toBeDisabled();
  await expect(list.getByText('(unread)')).toHaveCount(0);
  await page.reload();
  await expect(bell(page, 'Activity')).toBeVisible(); // persisted, not just shown
});

test('a reply in a thread you replied to is listed under Threads, and level Off hides the channel', async ({
  browser,
}) => {
  const {
    owner,
    org,
    members: [bea],
    url,
    post,
  } = await channelOf(browser, 'Arlo', 'Bree');
  const root = await post(owner, 'should we move the launch?');
  await post(bea!, 'yes, a week later', { threadRootId: root.id });
  await post(owner, 'agreed, one more week then', { threadRootId: root.id });

  const page = bea!.page;
  await page.goto(`/o/${org.slug}/activity`);
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  const list = page.getByRole('list', { name: 'Activity' });
  await expect(list.getByRole('link', { name: /Arlo replied in a thread/ })).toContainText(
    'agreed, one more week then',
  );
  await page.getByRole('button', { name: 'Mentions', exact: true }).click();
  await expect(page.getByText('Nobody has mentioned you yet.')).toBeVisible();

  // Turning the channel Off hides its items.
  await page.goto(url);
  await page.getByRole('button', { name: 'Notifications: All' }).click();
  await page.getByRole('menuitemradio', { name: /Off/ }).click();
  await expect(page.getByRole('button', { name: 'Notifications: Off' })).toBeVisible();
  await page.goto(`/o/${org.slug}/activity`);
  await expect(page.getByText('Mentions of you and replies in threads you take part in show up here.')).toBeVisible();
  await expect(list).toHaveCount(0);
  const { data } = await call<{ data: unknown[] }>(bea!, 'get', `/orgs/${org.id}/activity`);
  expect(data).toEqual([]);
});
