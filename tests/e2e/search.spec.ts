import { call, createWorkspace, expect, joinWorkspace, orgOf, test } from './support/fixtures.js';

test('Ctrl+K opens the palette, finds a person, a channel and a workspace, and keys open the result', async ({
  browser,
}) => {
  const { owner, org } = await orgOf(browser, 'Sana', 'Quillfeather');
  const workspace = await createWorkspace(owner, org, 'Zephyr Works');
  await call(owner, 'post', `/orgs/${org.id}/workspaces/${workspace.id}/channels`, {
    name: 'launch-plan',
    type: 'public',
  });
  const page = owner.page;
  await page.goto(`/o/${org.slug}`);
  await expect(page.getByRole('main')).toBeVisible();

  const open = async () => {
    await expect(page.getByRole('button', { name: 'Search' })).toBeVisible(); // the shortcut works once the org has loaded
    await page.keyboard.press('Control+K');
    const box = page.getByRole('combobox', { name: 'Search' });
    await expect(box).toBeFocused();
    return box;
  };

  let box = await open();
  await box.fill('Quillfeather');
  await expect(page.getByRole('option', { name: /^Quillfeather/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(box).toHaveCount(0);

  box = await open();
  await box.fill('launch-plan');
  await expect(page.getByRole('option', { name: /^launch-plan/ })).toBeVisible();
  await box.fill('Zephyr');
  await expect(page.getByRole('option', { name: /^Zephyr Works/ })).toBeVisible();

  // Keyboard only: the first result is active, Enter opens it.
  await box.fill('launch-plan');
  await expect(page.getByRole('option', { name: /^launch-plan/ })).toHaveAttribute('aria-selected', 'true');
  // Enter is ignored while results are still settling, so a stale result never opens: wait until they have.
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText(/\d+ results?\./);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/w/${workspace.id}/c/`));
  await expect(page.getByRole('log', { name: 'Messages in #launch-plan' })).toBeVisible();

  // Selecting a person starts a direct conversation with them.
  box = await open();
  await box.fill('Quillfeather');
  await page.getByRole('option', { name: /^Quillfeather/ }).click();
  await expect(page).toHaveURL(/\/messages\//);
});

test('a private channel never appears for someone who is not in it', async ({ browser }) => {
  const {
    owner,
    org,
    members: [outsider],
  } = await orgOf(browser, 'Priya', 'Oskar');
  const workspace = await createWorkspace(owner, org);
  await joinWorkspace(outsider!, org, workspace);
  await call(owner, 'post', `/orgs/${org.id}/workspaces/${workspace.id}/channels`, {
    name: 'secret-roadmap',
    type: 'private',
  });

  const search = async (who: typeof owner) => {
    await who.page.goto(`/o/${org.slug}`);
    await expect(who.page.getByRole('main')).toBeVisible();
    await expect(who.page.getByRole('button', { name: 'Search' })).toBeVisible();
    await who.page.keyboard.press('Control+K');
    const box = who.page.getByRole('combobox', { name: 'Search' });
    await expect(box).toBeFocused();
    await box.fill('secret-roadmap');
    return who.page;
  };

  const ownerPage = await search(owner);
  await expect(ownerPage.getByRole('option', { name: /^secret-roadmap/ })).toBeVisible();

  const outsiderPage = await search(outsider!);
  await expect(outsiderPage.getByRole('status')).toContainText('No results for');
  await expect(outsiderPage.getByRole('option', { name: /^secret-roadmap/ })).toHaveCount(0);
});
