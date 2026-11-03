import { axeViolations, blocking, THEMES, useTheme, type AxeViolation } from './support/axe.js';
import { channelOf, uploadFile } from './support/channel.js';
import { call, createWorkspace, expect, joinWorkspace, newContext, orgOf, test } from './support/fixtures.js';

test.describe('axe-core in a real browser', () => {
  test.setTimeout(240_000);

  for (const theme of THEMES) {
    test(`public and signed-in pages have no serious or critical violations (${theme} theme)`, async ({ browser }) => {
      const {
        owner,
        org,
        members: [ben, cat],
      } = await orgOf(browser, 'Axel', 'Ben', 'Cat');
      const workspace = await createWorkspace(owner, org, 'Atlas');
      await joinWorkspace(ben!, org, workspace);
      const dept = await call<{ id: string }>(owner, 'post', `/orgs/${org.id}/departments`, { name: 'Engineering' });
      await call(owner, 'post', `/orgs/${org.id}/teams`, {
        name: 'Platform',
        departmentId: dept.id,
        visibility: 'public',
      });
      const channel = `/orgs/${org.id}/workspaces/${workspace.id}/channels/${workspace.generalId}`;
      await call(owner, 'post', `${channel}/messages`, { body: 'hello, accessible world' });
      await call(ben!, 'post', `${channel}/messages`, { body: 'a reply from Ben' });
      const dm = await call<{ id: string }>(
        owner,
        'post',
        `/orgs/${org.id}/conversations/direct`,
        { userId: ben!.userId },
        201,
      );
      await call(owner, 'post', `/orgs/${org.id}/conversations/${dm.id}/messages`, { body: 'a direct hello' });
      const group = await call<{ id: string }>(
        owner,
        'post',
        `/orgs/${org.id}/conversations/groups`,
        { title: 'Crew', userIds: [ben!.userId, cat!.userId] },
        201,
      );

      const all: AxeViolation[] = [];
      const check = async (page: typeof owner.page, label: string, path: string) => {
        await page.goto(path);
        await expect(page.getByRole('main')).toBeVisible();
        all.push(...(await axeViolations(page, label, theme)).map((v) => ({ ...v, id: `${label}: ${v.id}` })));
      };

      // Public pages, in their own anonymous browser.
      const anonymous = await (await newContext(browser)).newPage();
      await useTheme(anonymous, theme);
      for (const [label, path] of [
        ['login', '/login'],
        ['register', '/register'],
        ['forgot password', '/forgot-password'],
      ] as const) {
        await check(anonymous, label, path);
      }

      await useTheme(owner.page, theme);
      const base = `/o/${org.slug}`;
      for (const [label, path] of [
        ['overview', base],
        ['workspaces', `${base}/workspaces`],
        ['workspace', `${base}/w/${workspace.id}`],
        ['channel', `${base}/w/${workspace.id}/c/${workspace.generalId}`],
        ['workspace settings', `${base}/w/${workspace.id}/settings`],
        ['members', `${base}/members`],
        ['invitations', `${base}/invitations`],
        ['departments', `${base}/departments`],
        ['teams', `${base}/teams`],
        ['organization settings', `${base}/settings`],
        ['messages', `${base}/messages`],
        ['direct message', `${base}/messages/${dm.id}`],
        ['group', `${base}/messages/${group.id}`],
        ['account sessions', '/account/sessions'],
        ['account password', '/account/password'],
        ['not found', '/nowhere/at/all'],
      ] as const) {
        await check(owner.page, label, path);
      }

      // Overlays: a form dialog, and the group details panel.
      await owner.page.goto(`${base}/departments`);
      await owner.page.getByRole('button', { name: 'New department' }).click();
      await expect(owner.page.getByRole('dialog', { name: 'New department' })).toBeVisible();
      all.push(...(await axeViolations(owner.page, 'new department dialog', theme)));
      await owner.page.goto(`${base}/messages/${group.id}`);
      await owner.page.getByRole('button', { name: 'Details' }).click();
      await expect(owner.page.getByRole('complementary', { name: 'Group details' })).toBeVisible();
      all.push(...(await axeViolations(owner.page, 'group details panel', theme)));

      expect(blocking(all).map((v) => `${v.id} (${v.impact})`)).toEqual([]);
    });
  }

  for (const theme of THEMES) {
    test(`files, search, activity, saved, thread, context and attachment chips are accessible (${theme} theme)`, async ({
      browser,
    }) => {
      test.setTimeout(240_000);
      const {
        owner,
        org,
        members: [ben],
        url,
        base,
        post,
      } = await channelOf(browser, 'Axel', 'Ben');
      const root = await post(owner, 'zebra planning thread');
      await post(ben!, `a reply mentioning <@${owner.userId}>`, { threadRootId: root.id });
      const hit = await post(ben!, `zebra roadmap for <@${owner.userId}>`);
      await post(owner, 'a message after the hit');
      await call(owner, 'put', `${base}/messages/${hit.id}/bookmark`, undefined, 204);
      const fileId = await uploadFile(owner, org.id, 'zebra-notes.txt', Buffer.from('notes'));
      await post(owner, 'with a file', { attachmentFileIds: [fileId] });

      const page = owner.page;
      await useTheme(page, theme);
      const all: AxeViolation[] = [];
      const check = async (label: string) => {
        await expect(page.getByRole('main')).toBeVisible();
        all.push(...(await axeViolations(page, label, theme)).map((v) => ({ ...v, id: `${label}: ${v.id}` })));
      };
      const orgBase = `/o/${org.slug}`;
      for (const [label, path, ready] of [
        ['files', `${orgBase}/files`, 'zebra-notes.txt'],
        ['search results', `${orgBase}/search?q=zebra`, 'zebra roadmap'],
        ['activity', `${orgBase}/activity`, 'mentioned you'],
        ['saved', `${orgBase}/saved`, 'zebra roadmap'],
      ] as const) {
        await page.goto(path);
        await expect(page.getByText(ready).first()).toBeVisible();
        await check(label);
      }

      await page.goto(`${url}?message=${hit.id}`);
      await expect(
        page.getByRole('complementary', { name: 'Message in context' }).locator('[data-highlight]'),
      ).toBeVisible();
      await check('context panel');

      await page.goto(url);
      const log = page.getByRole('log', { name: 'Messages in #general' });
      await log
        .getByRole('listitem')
        .filter({ hasText: 'zebra planning thread' })
        .getByRole('button', { name: 'Message actions' })
        .click();
      await page.getByRole('menuitem', { name: 'Reply in thread' }).click();
      await expect(page.getByRole('complementary', { name: 'Thread' }).getByText(/a reply mentioning/)).toBeVisible();
      await check('thread panel');

      await page.goto(url);
      await page
        .getByLabel('Choose files to attach')
        .setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
      await expect(page.getByRole('button', { name: 'Remove draft.txt' })).toBeVisible();
      await check('attachment chip');

      expect(blocking(all).map((v) => `${v.id} (${v.impact})`)).toEqual([]);
    });
  }

  test('the theme menu switches themes, remembers the choice and keeps the page accessible', async ({ browser }) => {
    const { owner, org } = await orgOf(browser, 'Thea');
    const page = owner.page;
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(`/o/${org.slug}`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await page.getByRole('button', { name: /^Theme:/ }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate("localStorage.getItem('sc-theme')")).toBe('dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(blocking(await axeViolations(page, 'overview via theme menu', 'dark'))).toEqual([]);

    await page.getByRole('button', { name: 'Theme: Dark' }).click();
    await page.getByRole('menuitemradio', { name: 'Light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(blocking(await axeViolations(page, 'overview via theme menu', 'light'))).toEqual([]);
  });

  // Regression (found by this suite, fixed): the sidebar switchers' accessible names left out visible text, failing
  // WCAG 2.5.3 (label-content-name-mismatch). The other pages' checks also cover it now that nothing is excluded.
  test('the sidebar switchers name what they show (label in name)', async ({ browser }) => {
    const { owner, org } = await orgOf(browser, 'Lane');
    await createWorkspace(owner, org, 'Atlas');
    await owner.page.goto(`/o/${org.slug}`);
    await expect(owner.page.getByRole('main')).toBeVisible();
    const found = await axeViolations(owner.page, 'sidebar switchers', 'light', ['label-content-name-mismatch']);
    expect(found).toEqual([]);
  });
});
