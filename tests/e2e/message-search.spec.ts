import { channelOf, privateChannel, uploadFile } from './support/channel.js';
import { call, expect, test } from './support/fixtures.js';

test('modifiers become chips, a result opens the message in context and Jump to latest leaves it', async ({
  browser,
}) => {
  const {
    owner,
    org,
    members: [quill],
    url,
    post,
  } = await channelOf(browser, 'Sol', 'Quillan');
  await post(owner, 'older zebra thoughts from Sol');
  await post(quill!, 'the zebra roadmap is ready');
  await post(owner, 'a neighbour after the hit');
  const page = owner.page;
  await page.goto(`/o/${org.slug}/search`);

  const box = page.getByRole('searchbox', { name: 'Search this organization' });
  await box.fill('zebra in:#general from:@Quillan ');
  const filters = page.getByRole('group', { name: 'Filters' });
  await expect(filters.getByRole('button', { name: 'Remove filter in: #general' })).toBeVisible();
  await expect(filters.getByRole('button', { name: 'Remove filter from: Quillan' })).toBeVisible();

  // Only Quillan's message matches the words and both filters.
  const messages = page.getByRole('region', { name: /^Messages/ });
  const hit = messages.getByRole('button', { name: /zebra roadmap is ready/ });
  await expect(hit).toBeVisible();
  await expect(messages.getByRole('button')).toHaveCount(1);

  await hit.click();
  await expect(page).toHaveURL(new RegExp(`${url}\\?message=`));
  const panel = page.getByRole('complementary', { name: 'Message in context' });
  await expect(panel).toBeVisible();
  const target = panel.locator('[data-highlight]');
  await expect(target).toContainText('the zebra roadmap is ready');
  await expect(panel.getByText('a neighbour after the hit')).toBeVisible();

  await panel.getByRole('button', { name: 'Jump to latest' }).click();
  await expect(panel).toHaveCount(0);
  await expect(page).not.toHaveURL(/message=/);
  await expect(
    page.getByRole('log', { name: 'Messages in #general' }).getByText('a neighbour after the hit'),
  ).toBeVisible();
});

// Regression (found by this suite, fixed): a stray second setNotice in search-page.tsx always showed
// "No single match for  and …" after a modifier resolved cleanly.
test('resolved modifiers leave no "No single match" notice', async ({ browser }) => {
  const { owner, org } = await channelOf(browser, 'Nell');
  await owner.page.goto(`/o/${org.slug}/search`);
  await owner.page.getByRole('searchbox', { name: 'Search this organization' }).fill('anything in:#general ');
  await expect(owner.page.getByRole('button', { name: 'Remove filter in: #general' })).toBeVisible();
  await expect(owner.page.getByRole('status').filter({ hasText: 'No single match' })).toHaveCount(0);
});

test('a removed chip widens the search again', async ({ browser }) => {
  const {
    owner,
    org,
    members: [other],
    post,
  } = await channelOf(browser, 'Una', 'Odo');
  await post(owner, 'giraffe by Una');
  await post(other!, 'giraffe by Odo');
  const page = owner.page;
  await page.goto(`/o/${org.slug}/search?q=giraffe`);
  const messages = page.getByRole('region', { name: /^Messages/ });
  await expect(messages.getByRole('button')).toHaveCount(2);
  await page.getByRole('button', { name: 'From…' }).click();
  await page.getByRole('searchbox', { name: 'Find a person' }).fill('Odo');
  await page.getByRole('button', { name: /^Odo/ }).click();
  await expect(messages.getByRole('button')).toHaveCount(1);
  await page.getByRole('button', { name: 'Remove filter from: Odo' }).click();
  await expect(messages.getByRole('button')).toHaveCount(2);
});

test('a file attached to a message appears in the Files results', async ({ browser }) => {
  const {
    owner,
    org,
    members: [reader],
    post,
  } = await channelOf(browser, 'Fern', 'Reed');
  const fileId = await uploadFile(owner, org.id, 'quarterly-report.txt', Buffer.from('numbers'));
  await post(owner, 'report attached', { attachmentFileIds: [fileId] });

  await reader!.page.goto(`/o/${org.slug}/search?q=quarterly`);
  const files = reader!.page.getByRole('region', { name: /^Files/ });
  await expect(files.getByRole('button', { name: /quarterly-report\.txt/ })).toBeVisible();
});

test('a private channel message never appears in search for someone outside the channel', async ({ browser }) => {
  const setup = await channelOf(browser, 'Pia', 'Ines', 'Olaf');
  const [insider, outsider] = setup.members as [(typeof setup.members)[0], (typeof setup.members)[0]];
  const secret = await privateChannel(setup, 'war-room', insider);
  await call(setup.owner, 'post', `${secret.base}/messages`, { body: 'hushword launch date is Friday' });

  const search = (who: typeof setup.owner) => who.page.goto(`/o/${setup.org.slug}/search?q=hushword`);
  await search(insider);
  await expect(
    insider.page.getByRole('region', { name: /^Messages/ }).getByRole('button', { name: /hushword launch/ }),
  ).toBeVisible();

  await search(outsider);
  await expect(outsider.page.getByText('No messages match “hushword”.')).toBeVisible();
  await expect(outsider.page.getByText(/launch date/)).toHaveCount(0);
  const api = await call<{ data: unknown[] }>(outsider, 'get', `/orgs/${setup.org.id}/message-search?q=hushword`);
  expect(api.data).toEqual([]);
});
