// Platform administration in a real browser (ADR 0015): /admin/login on the ordinary login, the forced replacement of
// an issued password, then the dashboard; and an organization owner refused by the page and by the API. The Super
// Admin role and the "issued password" mark are set directly in the test database, as `make admin-seed` does for the
// development database (which these tests never touch).
import pg from 'pg';
import { createOrg, expect, founderEmail, newContext, person, PASSWORD, test } from './support/fixtures.js';

const OWN_PASSWORD = 'my own long admin passphrase';

async function makeSuperAdminWithIssuedPassword(email: string): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.E2E_IDENTITY_DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `insert into identity.platform_role_assignments (user_id, role)
         select id, 'super_admin' from identity.users where email_normalized = $1`,
      [email.toLowerCase()],
    );
    await client.query(
      `update identity.credentials c set change_required = true
         from identity.users u where u.id = c.user_id and u.email_normalized = $1 and c.type = 'password'`,
      [email.toLowerCase()],
    );
  } finally {
    await client.end();
  }
}

test('a Super Admin signs in at /admin/login, replaces the issued password and reaches the dashboard', async ({
  browser,
}) => {
  const founder = await person(browser, 'Founder', founderEmail());
  const org = await createOrg(founder);
  const admin = await person(browser, 'Root');
  await makeSuperAdminWithIssuedPassword(admin.email);

  const page = await (await newContext(browser)).newPage();
  await page.goto('/admin/login');
  await page.getByLabel('Admin ID').fill(admin.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Choose your password' })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/password$/);
  await page.getByLabel('Current password').fill(PASSWORD);
  await page.getByLabel('New password', { exact: true }).fill(OWN_PASSWORD);
  await page.getByLabel('Confirm new password').fill(OWN_PASSWORD);
  await page.getByRole('button', { name: 'Save and continue' }).click();

  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Platform administration' })).toBeVisible();
  await expect(page.getByRole('rowheader', { name: org.name })).toBeVisible();
  await expect(page.getByText('Super Admins')).toBeVisible();
});

test('an organization owner is refused at /admin/login and by the admin API', async ({ browser }) => {
  const owner = await person(browser, 'Owner', founderEmail());
  await createOrg(owner);

  const page = await (await newContext(browser)).newPage();
  await page.goto('/admin/login');
  await page.getByLabel('Admin ID').fill(owner.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('This account is not a platform administrator.');
  await expect(page).toHaveURL(/\/admin\/login/);

  // Whatever the page does, the API refuses the account.
  for (const path of ['/api/v1/admin/accounts/summary', '/api/v1/admin/organizations']) {
    const res = await owner.api.get(path, { headers: { Authorization: `Bearer ${owner.token}` } });
    expect(res.status()).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('platform_admin_required');
  }
});
