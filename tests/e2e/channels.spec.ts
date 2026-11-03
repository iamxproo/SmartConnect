import { createWorkspace, expect, joinWorkspace, orgOf, test } from './support/fixtures.js';

test('public and private channels: the other member sees only the public one, and cannot open the private one', async ({
  browser,
}) => {
  const {
    owner,
    org,
    members: [member],
  } = await orgOf(browser, 'Cleo', 'Milo');
  const workspace = await createWorkspace(owner, org, 'Studio');
  await joinWorkspace(member!, org, workspace);
  const page = owner.page;
  await page.goto(`/o/${org.slug}/w/${workspace.id}`);

  await page.getByRole('button', { name: 'New channel' }).click();
  await page.getByLabel('Channel name').fill('announcements');
  await page.getByLabel('Topic (optional)').fill('News for everyone');
  await page.getByRole('button', { name: 'Create channel' }).click();
  await expect(page.getByRole('heading', { name: '# announcements' })).toBeVisible();

  await page.goto(`/o/${org.slug}/w/${workspace.id}`);
  await page.getByRole('button', { name: 'New channel' }).click();
  await page.getByLabel('Channel name').fill('leadership');
  await page.getByLabel('Type').selectOption('private');
  await page.getByRole('button', { name: 'Create channel' }).click();
  await expect(page.getByRole('heading', { name: '# leadership' })).toBeVisible();
  await expect(page.getByText('Private', { exact: true })).toBeVisible();
  const privateUrl = new URL(page.url()).pathname;
  expect(privateUrl).toMatch(/\/c\/[0-9a-f-]+$/);

  // The creator's sidebar lists both.
  const mine = page.getByRole('navigation', { name: 'Channels' });
  await expect(mine.getByRole('link', { name: 'announcements' })).toBeVisible();
  await expect(mine.getByRole('link', { name: 'leadership' })).toBeVisible();

  // The other member sees the public channel only.
  await member!.page.goto(`/o/${org.slug}/w/${workspace.id}`);
  const channelList = member!.page.getByRole('region', { name: 'Channels' });
  await expect(channelList.getByRole('link', { name: 'announcements' }).first()).toBeVisible();
  await expect(channelList.getByRole('link', { name: 'general' }).first()).toBeVisible();
  await expect(member!.page.getByRole('link', { name: 'leadership' })).toHaveCount(0);

  // Opening the private channel's URL directly shows not-found and no channel content.
  await member!.page.goto(privateUrl);
  await expect(member!.page.getByRole('heading', { name: 'Channel not found' })).toBeVisible();
  await expect(member!.page.getByRole('heading', { name: '# leadership' })).toHaveCount(0);
  await expect(member!.page.getByRole('log')).toHaveCount(0);
  await expect(member!.page.getByRole('textbox', { name: /Message #leadership/ })).toHaveCount(0);
});
