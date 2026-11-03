// Self-service onboarding (ADR 0017), all through the UI of two real browsers: a new person registers, verifies, signs
// in, creates their company's organization and invites an employee by email; the employee opens the invitation link,
// creates an account from it, verifies, signs in and accepts; then both talk in a direct conversation and in a
// workspace channel the owner created. Only the emails' links come from the dev mailboxes, as from an inbox.
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, invitationToken, newContext, PASSWORD, test, verificationToken } from './support/fixtures.js';

async function register(page: Page, name: string, email: string) {
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
}

/** Opens the verification link from the email, as a mail client does: in `page`, or in a new tab. */
async function verify(page: Page, email: string) {
  await page.goto(`/verify-email#token=${encodeURIComponent(await verificationToken(email))}`);
  await expect(page.getByText('Your email address is verified.')).toBeVisible();
}

async function signIn(page: Page, email: string) {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('a new person creates their organization, invites an employee who joins, and they talk', async ({ browser }) => {
  const run = randomUUID().slice(0, 6);
  const company = `Olivia Industries ${run}`;
  const ownerEmail = `olivia-${randomUUID()}@example.com`;
  const employeeEmail = `ethan-${randomUUID()}@example.com`;

  // The owner registers, verifies and signs in.
  const owner = await (await newContext(browser)).newPage();
  await owner.goto('/register');
  await register(owner, 'Olivia Owner', ownerEmail);
  await verify(owner, ownerEmail);
  await owner.goto('/login');
  await signIn(owner, ownerEmail);

  // With no organization yet, the home page offers to create one; the creator lands on its overview as owner.
  await expect(owner.getByRole('heading', { name: 'Create your organization' })).toBeVisible();
  await owner.getByRole('link', { name: 'Create an organization' }).click();
  await owner.getByLabel('Company name').fill(company);
  const slug = await owner.getByLabel('Address').inputValue();
  await owner.getByRole('button', { name: 'Create organization' }).click();
  await expect(owner).toHaveURL(new RegExp(`/o/${slug}$`));
  await expect(owner.getByRole('heading', { name: company })).toBeVisible();

  // Get started → invite the employee by email; the list shows the invitation and that its email went out.
  const getStarted = owner.getByRole('region', { name: 'Get started' });
  await getStarted.getByRole('link', { name: 'Invite people' }).click();
  await owner.getByLabel('Email address').fill(employeeEmail);
  await owner.getByLabel('Role').selectOption({ label: 'Member' });
  await owner.getByRole('button', { name: 'Send invitation' }).click();
  await expect(owner.getByText('Invitation sent', { exact: true })).toBeVisible();
  const sent = owner.getByRole('region', { name: 'Sent invitations' });
  await expect(sent.getByText(employeeEmail)).toBeVisible();
  await expect(sent.getByText(/Email sent/)).toBeVisible();

  // The employee opens the link from the email and creates an account from it. The verification email opens in a
  // new tab; back in the first one (which still holds the invitation, in memory only), they sign in and accept.
  const employeeContext = await newContext(browser);
  const employee = await employeeContext.newPage();
  await employee.goto(`/invitations/accept#token=${encodeURIComponent(await invitationToken(employeeEmail))}`);
  await expect(employee.getByRole('heading', { name: `Join ${company}` })).toBeVisible();
  await employee.getByRole('link', { name: 'Create an account' }).click();
  await register(employee, 'Ethan Employee', employeeEmail);
  const mailTab = await employeeContext.newPage();
  await verify(mailTab, employeeEmail);
  await mailTab.close();
  await employee.getByRole('link', { name: 'Go to sign in' }).click();
  await signIn(employee, employeeEmail);
  await expect(employee.getByText(`signed in as ${employeeEmail}`)).toBeVisible();
  await employee.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(employee).toHaveURL(new RegExp(`/o/${slug}$`));
  await expect(employee.getByRole('heading', { name: company })).toBeVisible();

  // The owner sees the invitation accepted.
  await owner.reload();
  await expect(sent.getByText(employeeEmail)).toBeVisible();
  await expect(sent.getByText('accepted', { exact: true })).toBeVisible();

  // A direct message, live in both directions.
  await employee.goto(`/o/${slug}/messages`);
  await employee.getByRole('button', { name: 'New message' }).click();
  await employee.getByRole('combobox', { name: 'Find a person' }).fill('Olivia');
  await employee.getByRole('option', { name: /Olivia Owner/ }).click();
  await employee.getByRole('textbox', { name: 'Message Olivia Owner' }).fill('Hi Olivia, I joined!');
  await employee.getByRole('button', { name: 'Send message' }).click();
  await owner.goto(`/o/${slug}/messages`);
  await owner
    .getByRole('navigation', { name: 'Conversations' })
    .getByRole('link', { name: /Ethan Employee/ })
    .click();
  await expect(
    owner.getByRole('log', { name: 'Messages with Ethan Employee' }).getByText('Hi Olivia, I joined!'),
  ).toBeVisible();
  await owner.getByRole('textbox', { name: 'Message Ethan Employee' }).fill('Welcome, Ethan');
  await owner.getByRole('button', { name: 'Send message' }).click();
  await expect(
    employee.getByRole('log', { name: 'Messages with Olivia Owner' }).getByText('Welcome, Ethan'),
  ).toBeVisible();

  // The owner creates a workspace (the second step); the employee joins it and they talk in #general.
  await owner.goto(`/o/${slug}`);
  await owner.getByRole('region', { name: 'Get started' }).getByRole('link', { name: 'Open workspaces' }).click();
  await owner.getByRole('button', { name: 'New workspace' }).click();
  const dialog = owner.getByRole('dialog', { name: 'New workspace' });
  await dialog.getByLabel('Workspace name').fill('Headquarters');
  await dialog.getByRole('button', { name: 'Create workspace' }).click();
  await expect(owner.getByRole('heading', { name: 'Headquarters', level: 2 })).toBeVisible();
  await owner.getByRole('navigation', { name: 'Channels' }).getByRole('link', { name: 'general' }).click();
  const ownerChannel = owner.getByRole('log', { name: 'Messages in #general' });
  await expect(ownerChannel).toBeVisible();

  await employee.goto(`/o/${slug}/workspaces`);
  await employee.getByRole('button', { name: 'Join Headquarters' }).click();
  await expect(employee.getByRole('heading', { name: 'Headquarters', level: 2 })).toBeVisible();
  await employee.getByRole('navigation', { name: 'Channels' }).getByRole('link', { name: 'general' }).click();
  await employee.getByRole('textbox', { name: 'Message #general' }).fill('Hello, everyone');
  await employee.getByRole('button', { name: 'Send message' }).click();
  await expect(ownerChannel.getByText('Hello, everyone')).toBeVisible();

  // Both steps done: the overview no longer shows them.
  await owner.goto(`/o/${slug}`);
  await expect(owner.getByRole('heading', { name: company })).toBeVisible();
  await expect(owner.getByRole('region', { name: 'Get started' })).toHaveCount(0);
});
