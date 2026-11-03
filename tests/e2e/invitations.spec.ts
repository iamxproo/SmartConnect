import { createOrg, expect, founderEmail, invitationToken, person, test } from './support/fixtures.js';

test('an admin invites through the UI; the wrong account is refused, the right one lands in the organization', async ({
  browser,
}) => {
  const admin = await person(browser, 'Admin', founderEmail());
  const org = await createOrg(admin);
  const invitee = await person(browser, 'Invitee');
  const stranger = await person(browser, 'Stranger');

  // The admin invites through the Invitations page.
  await admin.page.goto(`/o/${org.slug}/invitations`);
  await admin.page.getByLabel('Email address').fill(invitee.email);
  await admin.page.getByLabel('Role').selectOption(org.roles.member);
  await admin.page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(admin.page.getByText('Invitation sent')).toBeVisible();
  const sent = admin.page.getByRole('region', { name: 'Sent invitations' });
  await expect(sent.getByText(invitee.email)).toBeVisible();

  const link = `/invitations/accept#token=${encodeURIComponent(await invitationToken(invitee.email))}`;

  // Someone else opens the link: the invitation was sent to a different address.
  await stranger.page.goto(link);
  await expect(stranger.page.getByRole('heading', { name: `Join ${org.name}` })).toBeVisible();
  await stranger.page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(stranger.page.getByRole('alert')).toContainText('sent to a different email address');
  await expect(stranger.page.getByRole('button', { name: 'Sign out and use another account' })).toBeVisible();

  // The invited person accepts and lands in the organization.
  await invitee.page.goto(link);
  await expect(invitee.page.getByText(`signed in as ${invitee.email}`)).toBeVisible();
  await invitee.page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(invitee.page).toHaveURL(new RegExp(`/o/${org.slug}$`));
  await expect(invitee.page.getByRole('heading', { name: org.name })).toBeVisible();

  // The admin's list now shows the invitation as accepted.
  await admin.page.getByLabel('Filter by status').selectOption('accepted');
  await expect(sent.getByText(invitee.email)).toBeVisible();
  await expect(sent.getByText('accepted', { exact: true })).toBeVisible();
});
