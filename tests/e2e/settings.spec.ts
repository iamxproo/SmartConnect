import type { BrowserContext } from '@playwright/test';
import {
  createWorkspace,
  expect,
  joinWorkspace,
  newContext,
  orgOf,
  PASSWORD,
  person,
  test,
} from './support/fixtures.js';

import { WEB_URL } from './support/stack.js';

/** A browser's silent refresh: the status says whether that browser's session is still alive. */
const refreshStatus = async (context: BrowserContext) =>
  (await context.request.post('/api/v1/auth/refresh', { data: {}, headers: { Origin: WEB_URL } })).status();

test('organization settings are saved and persist after a reload; members see them read-only', async ({ browser }) => {
  const {
    owner,
    org,
    members: [member],
  } = await orgOf(browser, 'Orla', 'Mick');
  const page = owner.page;
  await page.goto(`/o/${org.slug}/settings`);

  const form = page.getByRole('form', { name: 'Organization settings' });
  await form.getByLabel('Name').fill('Renamed Holdings');
  await form.getByLabel('Description (optional)').fill('We make things.');
  await form.getByLabel('Invitations expire after (days)').fill('45');
  await form.getByRole('button', { name: 'Save changes' }).click();
  await expect(form.getByText('Enter a whole number of days from 1 to 30.')).toBeVisible();
  await form.getByLabel('Invitations expire after (days)').fill('9');
  await form.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Organization settings saved')).toBeVisible();

  await page.reload();
  await expect(form.getByLabel('Name')).toHaveValue('Renamed Holdings');
  await expect(form.getByLabel('Description (optional)')).toHaveValue('We make things.');
  await expect(form.getByLabel('Invitations expire after (days)')).toHaveValue('9');
  await expect(page.getByRole('button', { name: /^Organization: Renamed Holdings\b/ })).toBeVisible();

  // A plain member has no Settings entry and sees the values read-only.
  await member!.page.goto(`/o/${org.slug}/settings`);
  await expect(member!.page.getByText('Only administrators can change these.')).toBeVisible();
  await expect(member!.page.getByRole('form', { name: 'Organization settings' })).toHaveCount(0);
  await expect(member!.page.getByText('Renamed Holdings').first()).toBeVisible();
  await expect(
    member!.page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Settings' }),
  ).toHaveCount(0);
});

test('workspace settings are available to the workspace admin and not to a member', async ({ browser }) => {
  const {
    owner,
    org,
    members: [member],
  } = await orgOf(browser, 'Wes', 'Mia');
  const workspace = await createWorkspace(owner, org, 'Atlas');
  await joinWorkspace(member!, org, workspace);
  const url = `/o/${org.slug}/w/${workspace.id}`;

  await owner.page.goto(url);
  await owner.page.getByRole('main').getByRole('link', { name: 'Settings' }).click();
  await expect(owner.page.getByRole('heading', { name: 'Workspace settings', level: 2 })).toBeVisible();
  const form = owner.page.getByRole('form', { name: 'Workspace settings' });
  await form.getByLabel('Name').fill('Atlas Prime');
  await form.getByLabel('Description (optional)').fill('The big one');
  await form.getByLabel('Visibility').selectOption('private');
  await form.getByRole('button', { name: 'Save changes' }).click();
  await expect(owner.page.getByText('Workspace settings saved')).toBeVisible();
  await owner.page.reload();
  await expect(form.getByLabel('Name')).toHaveValue('Atlas Prime');
  await expect(form.getByLabel('Visibility')).toHaveValue('private');

  // The member is not offered the entry and, by URL, is told it is for administrators.
  await member!.page.goto(url);
  await expect(member!.page.getByRole('heading', { name: 'Atlas Prime', level: 2 })).toBeVisible();
  await expect(member!.page.getByRole('main').getByRole('link', { name: 'Settings' })).toHaveCount(0);
  await member!.page.goto(`${url}/settings`);
  await expect(member!.page.getByRole('heading', { name: 'Administrators only' })).toBeVisible();
  await expect(member!.page.getByRole('form', { name: 'Workspace settings' })).toHaveCount(0);
});

test('sessions: lists them, ends one, signs out other devices and then this one', async ({ browser }) => {
  const ada = await person(browser, 'Ada');
  // Two more signed-in browsers for the same account.
  const others = [];
  for (let i = 0; i < 2; i++) {
    const context = await newContext(browser);
    const res = await context.request.post('/api/v1/auth/login', { data: { email: ada.email, password: PASSWORD } });
    expect(res.status()).toBe(200);
    others.push(context);
  }
  const page = ada.page;
  await page.goto('/account/sessions');
  const sessions = page.getByRole('region', { name: 'Active sessions' });
  await expect(sessions.getByRole('listitem')).toHaveCount(3);
  await expect(sessions.getByText('This device')).toHaveCount(1);

  // End one other session: it is gone from the list and that browser can no longer refresh.
  await sessions
    .getByRole('button', { name: /^End session on/ })
    .first()
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'End session' }).click();
  await expect(sessions.getByRole('listitem')).toHaveCount(2);
  const refreshed = await Promise.all(others.map(refreshStatus));
  expect(refreshed.sort()).toEqual([200, 401]);

  await page.getByRole('button', { name: 'Sign out other devices' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out other devices' }).click();
  await expect(sessions.getByRole('listitem')).toHaveCount(1);
  for (const context of others) {
    expect(await refreshStatus(context)).toBe(401);
  }

  // Revoking the current session lands on the sign-in page, and the session really is gone.
  await page.getByRole('button', { name: 'Sign out of this device' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/account/sessions');
  await expect(page).toHaveURL(/\/login/);
});

test('password change: a wrong current password is a field error; success ends the other sessions', async ({
  browser,
}) => {
  const ada = await person(browser, 'Ada');
  const otherContext = await newContext(browser);
  await otherContext.request.post('/api/v1/auth/login', { data: { email: ada.email, password: PASSWORD } });
  const other = await otherContext.newPage();
  await other.goto('/account/password');
  await expect(other.getByRole('heading', { name: 'Change password' })).toBeVisible();

  const page = ada.page;
  await page.goto('/account/password');
  const newPassword = 'a brand new passphrase 77';

  await page.getByLabel('Current password').fill('definitely not it 1234');
  await page.getByLabel('New password', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirm new password').fill(newPassword);
  await page.getByRole('button', { name: 'Change password' }).click();
  const current = page.getByLabel('Current password');
  await expect(current).toHaveAccessibleDescription('The current password is incorrect.');
  await expect(current).toBeFocused();

  await page.getByLabel('Confirm new password').fill('mismatch mismatch 99');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('The passwords do not match.')).toBeVisible();

  await page.getByLabel('Current password').fill(PASSWORD);
  await page.getByLabel('Confirm new password').fill(newPassword);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('Password changed')).toBeVisible();
  await expect(page.getByLabel('Current password')).toHaveValue('');
  await expect(page).toHaveURL(/\/account\/password/); // this session stays signed in

  // The other browser's session was ended: it is sent to sign in.
  await other.reload();
  await expect(other).toHaveURL(/\/login/);

  // The new password works, the old one does not.
  await other.getByLabel('Email').fill(ada.email);
  await other.getByLabel('Password').fill(PASSWORD);
  await other.getByRole('button', { name: 'Sign in' }).click();
  await expect(other.getByText('The email or password is incorrect.')).toBeVisible();
  await other.getByLabel('Password').fill(newPassword);
  await other.getByRole('button', { name: 'Sign in' }).click();
  await expect(other).not.toHaveURL(/\/login/);
});
