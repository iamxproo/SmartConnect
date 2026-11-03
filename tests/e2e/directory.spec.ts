import { expect, orgOf, test } from './support/fixtures.js';

test('creates, edits and deletes a department through the UI', async ({ browser }) => {
  const { owner, org } = await orgOf(browser, 'Dana');
  const page = owner.page;
  await page.goto(`/o/${org.slug}/departments`);

  await page.getByRole('button', { name: 'New department' }).click();
  let dialog = page.getByRole('dialog', { name: 'New department' });
  await dialog.getByLabel('Name').fill('Engineering');
  await dialog.getByLabel('Description (optional)').fill('Builds the product');
  await dialog.getByRole('button', { name: 'Create department' }).click();
  await expect(page.getByRole('heading', { name: 'Engineering' })).toBeVisible();

  // A sub-department shows its parent.
  await page.getByRole('button', { name: 'New department' }).click();
  dialog = page.getByRole('dialog', { name: 'New department' });
  await dialog.getByLabel('Name').fill('Platform');
  await dialog.getByLabel('Part of (optional)').selectOption({ label: 'Engineering' });
  await dialog.getByRole('button', { name: 'Create department' }).click();
  await expect(page.getByText('Part of Engineering')).toBeVisible();

  // Edit: the dialog is prefilled, and the change shows in the list.
  await page.getByRole('button', { name: 'Edit Engineering' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit Engineering' });
  await expect(dialog.getByLabel('Name')).toHaveValue('Engineering');
  await expect(dialog.getByLabel('Description (optional)')).toHaveValue('Builds the product');
  await dialog.getByLabel('Name').fill('Product Engineering');
  await dialog.getByLabel('Description (optional)').fill('Builds and runs the product');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('heading', { name: 'Product Engineering' })).toBeVisible();
  await expect(page.getByText('Builds and runs the product')).toBeVisible();
  await expect(page.getByText('Part of Product Engineering')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Product Engineering' })).toBeVisible();

  // A department with a sub-department cannot be deleted; an empty one can.
  await page.getByRole('button', { name: 'Delete Product Engineering' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete department' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('is not empty');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'Delete Platform' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete department' }).click();
  await expect(page.getByRole('heading', { name: 'Platform' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Product Engineering' })).toBeVisible();
});

test('creates, edits and deletes teams; a private team is invisible to another member', async ({ browser }) => {
  const {
    owner,
    org,
    members: [member],
  } = await orgOf(browser, 'Tess', 'Milo');
  const page = owner.page;
  await page.goto(`/o/${org.slug}/teams`);

  await page.getByRole('button', { name: 'New team' }).click();
  let dialog = page.getByRole('dialog', { name: 'New team' });
  await dialog.getByLabel('Name').fill('Open Guild');
  await dialog.getByRole('button', { name: 'Create team' }).click();
  await expect(page.getByRole('heading', { name: 'Open Guild' })).toBeVisible();

  await page.getByRole('button', { name: 'New team' }).click();
  dialog = page.getByRole('dialog', { name: 'New team' });
  await dialog.getByLabel('Name').fill('Secret Society');
  await dialog.getByLabel('Visibility').selectOption('private');
  await dialog.getByRole('button', { name: 'Create team' }).click();
  await expect(page.getByRole('heading', { name: 'Secret Society' })).toBeVisible();

  // The other member sees the public team only.
  await member!.page.goto(`/o/${org.slug}/teams`);
  await expect(member!.page.getByRole('heading', { name: 'Open Guild' })).toBeVisible();
  await expect(member!.page.getByRole('heading', { name: 'Secret Society' })).toHaveCount(0);
  await expect(member!.page.getByRole('button', { name: 'New team' })).toHaveCount(0);

  // Edit the private team: rename it and make it public, and the member now sees it.
  await page.getByRole('button', { name: 'Edit Secret Society' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit Secret Society' });
  await expect(dialog.getByLabel('Visibility')).toHaveValue('private');
  await dialog.getByLabel('Name').fill('Open Secrets');
  await dialog.getByLabel('Description (optional)').fill('No longer secret');
  await dialog.getByLabel('Visibility').selectOption('public');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('heading', { name: 'Open Secrets' })).toBeVisible();
  await expect(page.getByText('No longer secret')).toBeVisible();
  await member!.page.reload();
  await expect(member!.page.getByRole('heading', { name: 'Open Secrets' })).toBeVisible();

  // Delete both teams.
  for (const name of ['Open Secrets', 'Open Guild']) {
    await page.getByRole('button', { name: `Delete ${name}` }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete team' }).click();
    await expect(page.getByRole('heading', { name })).toHaveCount(0);
  }
  await expect(page.getByRole('heading', { name: 'No teams to show' })).toBeVisible();
});
