import { expect, orgOf, test } from './support/fixtures.js';

test('creates a workspace through the UI, opens it, sees #general and moves between channels', async ({ browser }) => {
  const { owner, org } = await orgOf(browser, 'Wanda');
  const page = owner.page;

  await page.goto(`/o/${org.slug}/workspaces`);
  await expect(page.getByRole('heading', { name: 'No workspaces yet' })).toBeVisible();
  await page.getByRole('button', { name: 'New workspace' }).click();
  const dialog = page.getByRole('dialog', { name: 'New workspace' });
  await dialog.getByLabel('Workspace name').fill('Engineering Hub');
  await expect(dialog.getByLabel('Address')).toHaveValue('engineering-hub');
  await dialog.getByRole('button', { name: 'Create workspace' }).click();

  // Creating lands in the new workspace, whose default channel is general.
  await expect(page.getByRole('heading', { name: 'Engineering Hub', level: 2 })).toBeVisible();
  const channels = page.getByRole('navigation', { name: 'Channels' });
  await expect(channels.getByRole('link', { name: 'general' })).toBeVisible();

  await page.getByRole('button', { name: 'New channel' }).click();
  await page.getByLabel('Channel name').fill('random');
  await page.getByRole('button', { name: 'Create channel' }).click();
  await expect(page.getByRole('heading', { name: '# random' })).toBeVisible();
  await expect(channels.getByRole('link', { name: 'random' })).toBeVisible();

  await channels.getByRole('link', { name: 'general' }).click();
  await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();
  await expect(page.getByRole('log', { name: 'Messages in #general' })).toBeVisible();
  await channels.getByRole('link', { name: 'random' }).click();
  await expect(page.getByRole('log', { name: 'Messages in #random' })).toBeVisible();

  // The workspace switcher and the workspaces list reach the same place.
  await page.getByRole('link', { name: 'Workspaces', exact: true }).click();
  await page.getByRole('link', { name: 'Open Engineering Hub' }).click();
  await expect(page.getByRole('heading', { name: 'Engineering Hub', level: 2 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'general' }).first()).toBeVisible();
});
