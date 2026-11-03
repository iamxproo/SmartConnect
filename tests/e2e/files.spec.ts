import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { call, expect, join, orgOf, person, test } from './support/fixtures.js';

// A real 1x1 PNG: the files service detects the type from the bytes, and only a PNG, JPEG, GIF or WebP previews.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('uploads with the file picker, downloads the same bytes, previews an image and deletes', async ({ browser }) => {
  const { owner, org } = await orgOf(browser, 'Ines');
  const page = owner.page;
  await page.goto(`/o/${org.slug}/files`);
  await expect(page.getByText('No files yet')).toBeVisible();

  const bytes = randomBytes(40_000);
  await page.getByLabel('Choose files to upload').setInputFiles([
    { name: 'blob.bin', mimeType: 'application/octet-stream', buffer: bytes },
    { name: 'pixel.png', mimeType: 'image/png', buffer: PNG },
  ]);
  const list = page.getByRole('list', { name: 'Your files' });
  await expect(list.getByText('blob.bin')).toBeVisible();
  await expect(list.getByText('pixel.png')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Uploads' }).getByRole('progressbar')).toHaveCount(0);

  // Survives a reload: it is stored, not just shown.
  await page.reload();
  await expect(list.getByText('blob.bin')).toBeVisible();

  // Download: the browser saves exactly the bytes that were uploaded.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download blob.bin' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('blob.bin');
  expect(Buffer.compare(await readFile(await download.path()), bytes)).toBe(0);

  // Image preview opens a dialog showing the decoded image.
  await page.getByRole('button', { name: 'Preview pixel.png' }).click();
  const dialog = page.getByRole('dialog', { name: 'pixel.png' });
  const image = dialog.getByRole('img', { name: 'pixel.png' });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth)).toBe(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Delete (after confirming) removes the row, and it stays gone.
  await page.getByRole('button', { name: 'Delete blob.bin' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete file' }).click();
  await expect(list.getByText('blob.bin')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('list', { name: 'Your files' }).getByText('pixel.png')).toBeVisible();
  await expect(page.getByText('blob.bin')).toHaveCount(0);
});

test("another member cannot fetch someone else's file by its URL (404)", async ({ browser }) => {
  const { owner, org } = await orgOf(browser, 'Olga');
  const other = await person(browser, 'Nils');
  await join(org, owner, other);

  await owner.page.goto(`/o/${org.slug}/files`);
  await owner.page.getByLabel('Choose files to upload').setInputFiles({
    name: 'private.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('for my eyes only'),
  });
  await expect(owner.page.getByRole('list', { name: 'Your files' }).getByText('private.txt')).toBeVisible();
  const { data } = await call<{ data: { id: string; name: string }[] }>(owner, 'get', `/orgs/${org.id}/files`);
  const file = data.find((f) => f.name === 'private.txt')!;

  const fetchAs = (who: typeof owner, suffix = '') =>
    who.api.get(`/api/v1/orgs/${org.id}/files/${file.id}${suffix}`, {
      headers: { Authorization: `Bearer ${who.token}` },
    });
  expect((await fetchAs(owner, '/content')).status()).toBe(200);
  expect((await fetchAs(other)).status()).toBe(404);
  const stolen = await fetchAs(other, '/content');
  expect(stolen.status()).toBe(404);
  expect(await stolen.text()).not.toContain('for my eyes only');

  // Their own file list does not show it either.
  await other.page.goto(`/o/${org.slug}/files`);
  await expect(other.page.getByText('No files yet')).toBeVisible();
  await expect(other.page.getByText('private.txt')).toHaveCount(0);
});
