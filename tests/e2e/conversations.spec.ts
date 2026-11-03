import { call, expect, orgOf, test, type Org, type Person } from './support/fixtures.js';

interface Conversation {
  id: string;
}

const messagesUrl = (org: Org) => `/o/${org.slug}/messages`;
const startDirect = (from: Person, org: Org, other: Person) =>
  call<Conversation>(from, 'post', `/orgs/${org.id}/conversations/direct`, { userId: other.userId }, 201);

/** Time from pressing send until the other browser shows the text, without any reload. */
async function liveLatency(sender: Person, label: string, reader: Person, readerLog: string, body: string) {
  await sender.page.getByRole('textbox', { name: label }).fill(body);
  const sent = Date.now();
  await sender.page.getByRole('button', { name: 'Send message' }).click();
  await expect(reader.page.getByRole('log', { name: readerLog }).getByText(body)).toBeVisible({ timeout: 4_000 });
  return Date.now() - sent;
}

test('starts a DM from the member picker; the other person sees it live with an unread badge', async ({ browser }) => {
  const {
    owner: alice,
    org,
    members: [bob],
  } = await orgOf(browser, 'Alice', 'Bob');

  // Bob is already looking at his (empty) conversation list.
  await bob!.page.goto(messagesUrl(org));
  await expect(bob!.page.getByText('No conversations yet.')).toBeVisible();

  await alice.page.goto(messagesUrl(org));
  await alice.page.getByRole('button', { name: 'New message' }).click();
  await alice.page.getByRole('combobox', { name: 'Find a person' }).fill('Bob');
  await alice.page.getByRole('option', { name: /Bob/ }).click();
  await expect(alice.page).toHaveURL(/\/messages\/[0-9a-f-]+$/);
  await expect(alice.page.getByRole('heading', { name: 'Bob', level: 2 })).toBeVisible();

  await alice.page.getByRole('textbox', { name: 'Message Bob' }).fill('hi Bob');
  await alice.page.getByRole('button', { name: 'Send message' }).click();

  // Without a reload: the conversation appears in Bob's list with one unread message.
  const item = bob!.page.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: /Alice/ });
  await expect(item).toContainText('1 unread', { timeout: 6_000 });
  await item.click();
  await expect(bob!.page.getByRole('log', { name: 'Messages with Alice' }).getByText('hi Bob')).toBeVisible();
  // Opening it clears the badge.
  await expect(item).not.toContainText('unread');

  // Both directions, live.
  const toBob = await liveLatency(alice, 'Message Bob', bob!, 'Messages with Alice', 'ping from Alice');
  const toAlice = await liveLatency(bob!, 'Message Alice', alice, 'Messages with Bob', 'pong from Bob');
  console.log(`[realtime] DM latency without reload: Alice to Bob ${toBob} ms, Bob to Alice ${toAlice} ms`);

  // Starting a DM with the same person again reopens the one conversation.
  await alice.page.getByRole('button', { name: 'New message' }).click();
  await alice.page.getByRole('combobox', { name: 'Find a person' }).fill('Bob');
  await alice.page.getByRole('option', { name: /Bob/ }).click();
  await expect(alice.page.getByRole('log', { name: 'Messages with Bob' }).getByText('hi Bob')).toBeVisible();
  await expect(alice.page.getByRole('navigation', { name: 'Conversations' }).getByRole('link')).toHaveCount(1);
});

test('a group: create, rename, add, promote, demote, remove, leave', async ({ browser }) => {
  const {
    owner: gina,
    org,
    members: [hal, ivy],
  } = await orgOf(browser, 'Gina', 'Hal', 'Ivy', 'Jon');

  await ivy!.page.goto(messagesUrl(org));
  await expect(ivy!.page.getByText('No conversations yet.')).toBeVisible();

  await gina.page.goto(messagesUrl(org));
  await gina.page.getByRole('button', { name: 'New group' }).click();
  const dialog = gina.page.getByRole('dialog', { name: 'New group' });
  await expect(dialog.getByRole('button', { name: 'Create group' })).toBeDisabled();
  await dialog.getByLabel('Group name (optional)').fill('Launch crew');
  for (const name of ['Hal', 'Ivy']) {
    await dialog.getByRole('combobox', { name: 'Add people' }).fill(name);
    await dialog.getByRole('option', { name: new RegExp(name) }).click();
  }
  await expect(dialog.getByRole('list', { name: 'Chosen people' }).getByRole('listitem')).toHaveCount(2);
  await dialog.getByRole('button', { name: 'Create group' }).click();
  await expect(gina.page.getByRole('heading', { name: 'Launch crew', level: 2 })).toBeVisible();
  const url = new URL(gina.page.url()).pathname;

  // Ivy sees the new group in her list without reloading, then opens it.
  await expect(ivy!.page.getByRole('link', { name: /Launch crew/ })).toBeVisible({ timeout: 6_000 });
  await ivy!.page.getByRole('link', { name: /Launch crew/ }).click();
  await hal!.page.goto(url);
  await expect(hal!.page.getByRole('heading', { name: 'Launch crew', level: 2 })).toBeVisible();

  const groupLatency = await liveLatency(gina, 'Message Launch crew', ivy!, 'Messages with Launch crew', 'welcome all');
  console.log(`[realtime] group latency without reload: ${groupLatency} ms`);

  // Rename.
  await gina.page.getByRole('button', { name: 'Details' }).click();
  const panel = gina.page.getByRole('complementary', { name: 'Group details' });
  await panel.getByLabel('Group name').fill('Launch crew 2');
  await panel.getByRole('button', { name: 'Save name' }).click();
  await expect(gina.page.getByRole('heading', { name: 'Launch crew 2', level: 2 })).toBeVisible();
  await expect(ivy!.page.getByRole('heading', { name: 'Launch crew 2', level: 2 })).toBeVisible({ timeout: 8_000 });

  // Add Jon.
  await panel.getByRole('button', { name: 'Add people' }).click();
  const adding = gina.page.getByRole('dialog', { name: 'Add people' });
  await adding.getByRole('combobox', { name: 'Find a person to add' }).fill('Jon');
  await adding.getByRole('option', { name: /Jon/ }).click();
  await expect(panel.getByText('Participants (4)')).toBeVisible();

  // Promote and demote Hal; Gina, now the only admin again, cannot demote herself.
  await panel.getByRole('button', { name: 'Make admin: Hal' }).click();
  await expect(panel.getByRole('button', { name: 'Demote Hal to member' })).toBeVisible();
  await panel.getByRole('button', { name: 'Demote Hal to member' }).click();
  await expect(panel.getByRole('button', { name: 'Make admin: Hal' })).toBeVisible();
  await panel.getByRole('button', { name: 'Demote Gina to member' }).click();
  await expect(gina.page.getByText("Couldn't change the role")).toBeVisible();
  await expect(gina.page.getByText('You are the last administrator.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Demote Gina to member' })).toBeVisible();

  // Remove Ivy: her open conversation becomes unavailable and leaves her list, without a reload.
  await panel.getByRole('button', { name: 'Remove Ivy' }).click();
  await gina.page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(panel.getByText('Participants (3)')).toBeVisible();
  await expect(ivy!.page.getByRole('heading', { name: 'Conversation not available' })).toBeVisible({ timeout: 8_000 });
  await expect(ivy!.page.getByRole('link', { name: /Launch crew/ })).toHaveCount(0);
  await expect(ivy!.page.getByRole('log')).toHaveCount(0);

  // Hal leaves through the UI.
  await hal!.page.getByRole('button', { name: 'Details' }).click();
  await hal!.page
    .getByRole('complementary', { name: 'Group details' })
    .getByRole('button', { name: 'Leave group' })
    .click();
  await hal!.page.getByRole('dialog').getByRole('button', { name: 'Leave group' }).click();
  await expect(hal!.page).toHaveURL(new RegExp(`${messagesUrl(org)}$`));
  await expect(hal!.page.getByRole('link', { name: /Launch crew/ })).toHaveCount(0);
  await expect(panel.getByText('Participants (2)')).toBeVisible({ timeout: 8_000 });
});

test('a conversation you are not part of, and a guessed id, are not available (and expose nothing)', async ({
  browser,
}) => {
  const {
    owner: kim,
    org,
    members: [lee, max],
  } = await orgOf(browser, 'Kim', 'Lee', 'Max');
  const dm = await startDirect(kim, org, lee!);
  await call(kim, 'post', `/orgs/${org.id}/conversations/${dm.id}/messages`, { body: 'the secret plan' });

  // Max is an organization member but not a participant.
  await max!.page.goto(`${messagesUrl(org)}/${dm.id}`);
  await expect(max!.page.getByRole('heading', { name: 'Conversation not available' })).toBeVisible();
  await expect(max!.page.getByRole('log')).toHaveCount(0);
  await expect(max!.page.getByRole('textbox')).toHaveCount(0);
  expect(await max!.page.content()).not.toContain('the secret plan');

  await max!.page.goto(`${messagesUrl(org)}/00000000-0000-4000-8000-000000000000`);
  await expect(max!.page.getByRole('heading', { name: 'Conversation not available' })).toBeVisible();

  // The participant can open it.
  await lee!.page.goto(`${messagesUrl(org)}/${dm.id}`);
  await expect(lee!.page.getByText('the secret plan')).toBeVisible();
});

test('after the other person leaves the organization, sending in the DM is refused and the composer is disabled', async ({
  browser,
}) => {
  const {
    owner: kim,
    org,
    members: [lee],
  } = await orgOf(browser, 'Kim', 'Lee');
  const dm = await startDirect(kim, org, lee!);
  await call(kim, 'post', `/orgs/${org.id}/conversations/${dm.id}/messages`, { body: 'before you left' });
  await kim.page.goto(`${messagesUrl(org)}/${dm.id}`);
  await expect(kim.page.getByText('before you left')).toBeVisible();

  const { memberId } = await call<{ memberId: string }>(lee!, 'get', `/orgs/${org.id}/me`);
  await call(lee!, 'delete', `/orgs/${org.id}/members/${memberId}`);

  await kim.page.getByRole('textbox', { name: 'Message Lee' }).fill('are you there?');
  await kim.page.getByRole('button', { name: 'Send message' }).click();
  await expect(
    kim.page.getByRole('alert').filter({ hasText: 'is no longer in this organization' }).first(),
  ).toBeVisible();
  await expect(kim.page.getByRole('textbox', { name: 'Message Lee' })).toBeDisabled();
  await expect(kim.page.getByText('before you left')).toBeVisible();
});

test('on a phone the list and the open conversation take turns', async ({ browser }) => {
  const {
    owner: kim,
    org,
    members: [lee],
  } = await orgOf(browser, 'Kim', 'Lee');
  const dm = await startDirect(kim, org, lee!);
  await call(kim, 'post', `/orgs/${org.id}/conversations/${dm.id}/messages`, { body: 'hello phone' });
  const page = kim.page;
  await page.setViewportSize({ width: 390, height: 844 });
  const noOverflow = () => page.evaluate('document.documentElement.scrollWidth <= window.innerWidth');

  await page.goto(messagesUrl(org));
  const list = page.getByRole('navigation', { name: 'Conversations' });
  await expect(list.getByRole('link', { name: /Lee/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Select a conversation' })).toBeHidden();
  expect(await noOverflow()).toBe(true);

  await list.getByRole('link', { name: /Lee/ }).click();
  await expect(page.getByText('hello phone')).toBeVisible();
  await expect(list).toBeHidden();
  expect(await noOverflow()).toBe(true);

  await page.getByRole('link', { name: 'Back to conversations' }).click();
  await expect(list.getByRole('link', { name: /Lee/ })).toBeVisible();
  await expect(page.getByRole('log')).toHaveCount(0);

  // The shell navigation is reachable from the same page.
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
});
