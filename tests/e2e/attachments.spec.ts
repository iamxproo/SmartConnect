import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { channelOf, PNG, privateChannel, watchRealtime } from './support/channel.js';
import { call, expect, join, orgOf, person, test, type Person } from './support/fixtures.js';

const attach = (who: Person, file: { name: string; mimeType: string; buffer: Buffer }) =>
  who.page.getByLabel('Choose files to attach').setInputFiles(file);

const contentStatus = async (who: Person, orgId: string, fileId: string) =>
  (
    await who.api.get(`/api/v1/orgs/${orgId}/files/${fileId}/content`, {
      headers: { Authorization: `Bearer ${who.token}` },
    })
  ).status();

test('attaches a file with progress, the other member sees it live and downloads the same bytes', async ({
  browser,
}) => {
  const {
    owner,
    members: [reader],
    url,
  } = await channelOf(browser, 'Ada', 'Rue');
  const settled = watchRealtime(reader!.page);
  await reader!.page.goto(url);
  const readLog = reader!.page.getByRole('log', { name: 'Messages in #general' });
  await expect(readLog).toBeVisible();
  await settled();

  const page = owner.page;
  // Slow the byte upload down so the progress bar can be seen.
  await page.route('**/files/*/content', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });
  await page.goto(url);
  const bytes = randomBytes(30_000);
  await attach(owner, { name: 'plan.bin', mimeType: 'application/octet-stream', buffer: bytes });
  const chips = page.getByRole('list', { name: 'Attachments' });
  await expect(chips.getByRole('progressbar', { name: 'Uploading plan.bin' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await expect(chips.getByRole('button', { name: 'Remove plan.bin' })).toBeVisible();
  await page.getByRole('button', { name: 'Send message' }).click(); // a message may be only files

  const card = readLog.getByRole('list', { name: 'Files' });
  await expect(card.getByText('plan.bin')).toBeVisible({ timeout: 5_000 });
  const [download] = await Promise.all([
    reader!.page.waitForEvent('download'),
    card.getByRole('button', { name: 'Download plan.bin' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('plan.bin');
  expect(Buffer.compare(await readFile(await download.path()), bytes)).toBe(0);
  await expect(chips).toHaveCount(0); // the composer is clear again
});

test('an image attachment shows a thumbnail and opens the preview', async ({ browser }) => {
  const {
    owner,
    members: [reader],
    url,
  } = await channelOf(browser, 'Ira', 'Ravi');
  await owner.page.goto(url);
  await attach(owner, { name: 'pixel.png', mimeType: 'image/png', buffer: PNG });
  await expect(owner.page.getByRole('button', { name: 'Remove pixel.png' })).toBeVisible();
  await owner.page.getByRole('textbox', { name: 'Message #general' }).fill('look');
  await owner.page.getByRole('button', { name: 'Send message' }).click();

  await reader!.page.goto(url);
  const thumbs = reader!.page.getByRole('log', { name: 'Messages in #general' }).getByRole('list', { name: 'Images' });
  const thumb = thumbs.getByRole('img', { name: 'pixel.png' });
  await expect(thumb).toBeVisible();
  await expect.poll(() => thumb.evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth)).toBe(1);
  await thumbs.getByRole('button', { name: 'Preview pixel.png' }).click();
  const dialog = reader!.page.getByRole('dialog', { name: 'pixel.png' });
  await expect(dialog.getByRole('img', { name: 'pixel.png' })).toBeVisible();
  await reader!.page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('a private channel attachment is 404 for non-members, and deleting the message removes the members access', async ({
  browser,
}) => {
  const setup = await channelOf(browser, 'Pru', 'Mina', 'Otto');
  const [member, outsider] = setup.members as [Person, Person];
  const secret = await privateChannel(setup, 'secret-plans', member);
  const page = setup.owner.page;
  await page.goto(secret.url);
  await attach(setup.owner, { name: 'secret.txt', mimeType: 'text/plain', buffer: Buffer.from('eyes only') });
  await expect(page.getByRole('button', { name: 'Remove secret.txt' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message #secret-plans' }).fill('the file');
  await page.getByRole('button', { name: 'Send message' }).click();
  const log = page.getByRole('log', { name: 'Messages in #secret-plans' });
  await expect(log.getByRole('list', { name: 'Files' }).getByText('secret.txt')).toBeVisible();

  const { data } = await call<{ data: { attachments: { fileId: string }[] }[] }>(
    setup.owner,
    'get',
    `${secret.base}/messages`,
  );
  const fileId = data.find((m) => m.attachments.length > 0)!.attachments[0]!.fileId;
  const { org } = setup;
  expect(await contentStatus(setup.owner, org.id, fileId)).toBe(200);
  expect(await contentStatus(member, org.id, fileId)).toBe(200);
  expect(await contentStatus(outsider, org.id, fileId)).toBe(404);

  const message = log.getByRole('listitem').filter({ hasText: 'the file' });
  await message.getByRole('button', { name: 'Message actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete message' }).click();
  await expect(log.getByText('Message deleted')).toBeVisible();
  expect(await contentStatus(member, org.id, fileId)).toBe(404);
  expect(await contentStatus(setup.owner, org.id, fileId)).toBe(200); // the uploader keeps their own file
});

test('attaches a file in a direct conversation and the other person downloads it', async ({ browser }) => {
  const { owner, org } = await orgOf(browser, 'Dana');
  const friend = await person(browser, 'Finn');
  await join(org, owner, friend);
  const dm = await call<{ id: string }>(
    owner,
    'post',
    `/orgs/${org.id}/conversations/direct`,
    { userId: friend.userId },
    201,
  );
  const url = `/o/${org.slug}/messages/${dm.id}`;
  await friend.page.goto(url);
  await expect(friend.page.getByRole('textbox', { name: 'Message Dana' })).toBeVisible();

  const bytes = randomBytes(5_000);
  await owner.page.goto(url);
  await attach(owner, { name: 'notes.bin', mimeType: 'application/octet-stream', buffer: bytes });
  await expect(owner.page.getByRole('button', { name: 'Remove notes.bin' })).toBeVisible();
  await owner.page.getByRole('button', { name: 'Send message' }).click();

  const card = friend.page.getByRole('list', { name: 'Files' });
  await expect(card.getByText('notes.bin')).toBeVisible({ timeout: 10_000 });
  const [download] = await Promise.all([
    friend.page.waitForEvent('download'),
    card.getByRole('button', { name: 'Download notes.bin' }).click(),
  ]);
  expect(Buffer.compare(await readFile(await download.path()), bytes)).toBe(0);
});
