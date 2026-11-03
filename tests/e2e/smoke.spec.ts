import { expect, founderEmail, person, test } from './support/fixtures.js';

test('a verified person signs in through the UI and lands on the home page', async ({ browser }) => {
  const ada = await person(browser, 'Ada', founderEmail());
  const page = await (await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.9' } })).newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(ada.email);
  await page.getByLabel('Password').fill('correct horse battery staple 42');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('main')).toBeVisible();
});
