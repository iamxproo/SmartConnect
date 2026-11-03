import { call, expect, createWorkspace, orgOf, test } from './support/fixtures.js';

const problem = (status: number) => ({
  status,
  contentType: 'application/problem+json',
  body: JSON.stringify({ title: 'Unavailable', status, code: 'service_unavailable', detail: 'Try again shortly.' }),
});

test('a slow API call shows the loading state, then the data', async ({ browser }) => {
  const { owner, org } = await orgOf(browser, 'Lena');
  await call(owner, 'post', `/orgs/${org.id}/departments`, { name: 'Slowpoke Dept' });
  const page = owner.page;
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/v1/orgs/*/departments', async (route) => {
    await gate;
    await route.continue();
  });

  await page.goto(`/o/${org.slug}/departments`);
  const loading = page.getByRole('status').filter({ hasText: 'Loading departments' });
  await expect(loading).toBeVisible();
  await expect(loading).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByTestId('loading-skeleton')).toBeVisible(); // after the 150 ms anti-flash delay
  await expect(page.getByRole('heading', { name: 'Slowpoke Dept' })).toHaveCount(0);

  release();
  await expect(page.getByRole('heading', { name: 'Slowpoke Dept' })).toBeVisible();
  await expect(loading).toHaveCount(0);
});

test('a 503 shows the error state; Try again recovers', async ({ browser }) => {
  const { owner, org } = await orgOf(browser, 'Ewan');
  await call(owner, 'post', `/orgs/${org.id}/departments`, { name: 'Recovered Dept' });
  const page = owner.page;
  let failing = true;
  let calls = 0;
  await page.route('**/api/v1/orgs/*/departments', async (route) => {
    calls += 1;
    if (failing) await route.fulfill(problem(503));
    else await route.continue();
  });

  await page.goto(`/o/${org.slug}/departments`);
  const alert = page.getByRole('alert').filter({ hasText: "Couldn't load departments" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('SmartConnect is having trouble right now.');
  await expect(page.getByRole('heading', { name: 'Recovered Dept' })).toHaveCount(0);
  // The rest of the shell is still usable.
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

  failing = false;
  const before = calls;
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Recovered Dept' })).toBeVisible();
  await expect(alert).toHaveCount(0);
  expect(calls).toBeGreaterThan(before);
});

test('a failing message history shows an inline error; Try again recovers', async ({ browser }) => {
  const { owner, org } = await orgOf(browser, 'Maud');
  const workspace = await createWorkspace(owner, org);
  const base = `/orgs/${org.id}/workspaces/${workspace.id}/channels/${workspace.generalId}`;
  await call(owner, 'post', `${base}/messages`, { body: 'history survives' });
  const page = owner.page;
  let failing = true;
  let failures = 0;
  await page.route('**/channels/*/messages?*', async (route) => {
    if (failing && route.request().method() === 'GET') {
      failures += 1;
      await route.fulfill(problem(503));
    } else await route.continue();
  });

  await page.goto(`/o/${org.slug}/w/${workspace.id}/c/${workspace.generalId}`);
  const log = page.getByRole('log', { name: 'Messages in #general' });
  await expect(log.getByRole('alert')).toContainText('SmartConnect is having trouble right now.');
  await expect(log.getByText('history survives')).toHaveCount(0);
  // The first load and the refetch that follows the realtime subscription (or the 5 s poll when not live) both fail
  // first; otherwise that background refetch could recover the page between the switch below and the click.
  await expect.poll(() => failures, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

  // Still failing: the button must be there. Only then let the next request succeed, and click at once, so that a
  // background refetch (realtime, 5 s poll) cannot recover the page before the button's own refetch does.
  const retry = log.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();
  failing = false;
  // Dispatched on the button itself: in one of three runs a re-render moved it between Playwright's hit test and the
  // click (the click landed on <html>), and a later background refetch then recovered the page on its own. What is
  // under test here is that the button's own refetch recovers the history.
  await retry.dispatchEvent('click');
  await expect(log.getByText('history survives')).toBeVisible();
  await expect(log.getByRole('alert')).toHaveCount(0);
});
