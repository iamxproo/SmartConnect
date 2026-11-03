import { randomUUID } from 'node:crypto';
import { expect, newContext, PASSWORD, person, test, verificationToken } from './support/fixtures.js';

test('registers through the UI, verifies by the emailed link, signs in and signs out', async ({ browser }) => {
  const email = `grace-${randomUUID()}@example.com`;
  const page = await (await newContext(browser)).newPage();

  await page.goto('/register');
  await page.getByLabel('Your name').fill('Grace Hopper');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  await page.goto(`/verify-email#token=${encodeURIComponent(await verificationToken(email))}`);
  await expect(page.getByText('Your email address is verified.')).toBeVisible();

  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: "You're not part of a company yet" })).toBeVisible();

  await page.getByRole('button', { name: 'Account menu: Grace Hopper' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  // The session is really gone: a protected page now sends the browser back to sign in.
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
});

test('empty fields and a wrong password show errors', async ({ browser }) => {
  const ada = await person(browser, 'Ada');
  const page = await (await newContext(browser)).newPage();
  await page.goto('/login');

  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Enter your email address.')).toBeVisible();
  await expect(page.getByText('Enter your password.')).toBeVisible();

  await page.getByLabel('Email').fill(ada.email);
  await page.getByLabel('Password').fill('not the right password 1');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'The email or password is incorrect.' })).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test('a protected URL redirects to sign in and returns there afterwards', async ({ browser }) => {
  const ada = await person(browser, 'Ada');
  const page = await (await newContext(browser)).newPage();

  await page.goto('/account/password');
  await expect(page).toHaveURL(/\/login\?redirect=%2Faccount%2Fpassword/);

  await page.getByLabel('Email').fill(ada.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/account\/password$/);
  await expect(page.getByRole('heading', { name: 'Change password' })).toBeVisible();
});
