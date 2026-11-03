import { call, createOrg, expect, founderEmail, person, test } from './support/fixtures.js';

test('someone in two organizations switches between them and sees each one’s own data', async ({ browser }) => {
  const owner = await person(browser, 'Olga', founderEmail());
  const alpha = await createOrg(owner, 'Alpha Co');
  const beta = await createOrg(owner, 'Beta Co');
  await call(owner, 'post', `/orgs/${alpha.id}/departments`, { name: 'Alpha Engineering' });
  await call(owner, 'post', `/orgs/${beta.id}/departments`, { name: 'Beta Support' });
  const page = owner.page;

  // With two organizations the home page lists both.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your organizations' })).toBeVisible();
  await page.getByRole('link', { name: /Alpha Co/ }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${alpha.slug}$`));
  await expect(page.getByRole('heading', { name: 'Alpha Co' })).toBeVisible();

  const primary = page.getByRole('navigation', { name: 'Primary' });
  await primary.getByRole('link', { name: 'Departments' }).click();
  await expect(page.getByRole('heading', { name: 'Alpha Engineering' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Beta Support' })).toHaveCount(0);

  // Switch with the organization menu.
  await page.getByRole('button', { name: /^Organization: Alpha Co\b/ }).click();
  await page.getByRole('menuitemradio', { name: 'Beta Co' }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${beta.slug}$`));
  await expect(page.getByRole('button', { name: /^Organization: Beta Co\b/ })).toBeVisible();
  await primary.getByRole('link', { name: 'Departments' }).click();
  await expect(page.getByRole('heading', { name: 'Beta Support' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Alpha Engineering' })).toHaveCount(0);

  // And back again.
  await page.getByRole('button', { name: /^Organization: Beta Co\b/ }).click();
  await page.getByRole('menuitemradio', { name: 'Alpha Co' }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${alpha.slug}$`));
  await primary.getByRole('link', { name: 'Departments' }).click();
  await expect(page.getByRole('heading', { name: 'Alpha Engineering' })).toBeVisible();
});
