import { act, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubApi } from '@/test/api-stub';
import { inAcme } from '@/test/fixtures';
import { setSystemDark } from '@/test/media';
import { renderApp } from '@/test/render-app';
// The real static file served in <head> (Vite `?raw` import: works in the jsdom environment).
import script from '../../public/theme-init.js?raw';
import { DARK_MEDIA_QUERY, THEME_STORAGE_KEY } from './theme';

const html = document.documentElement;

async function chooseTheme(user: Awaited<ReturnType<typeof renderApp>>['user'], current: string, choice: string) {
  await user.click(screen.getByRole('button', { name: `Theme: ${current}` }));
  await user.click(within(await screen.findByRole('menu')).getByRole('menuitemradio', { name: choice }));
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    stubApi(inAcme());
  });

  it('follows the operating system by default, including live changes', async () => {
    setSystemDark(true);
    await renderApp('/');
    expect(html.dataset.theme).toBe('dark');
    expect(html.style.colorScheme).toBe('dark');

    act(() => setSystemDark(false));
    expect(html.dataset.theme).toBe('light');
  });

  it('applies and remembers an explicit choice from the theme menu', async () => {
    const { user } = await renderApp('/');
    await chooseTheme(user, 'System', 'Dark');
    expect(html.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    await chooseTheme(user, 'Dark', 'Light');
    expect(html.dataset.theme).toBe('light');

    setSystemDark(true);
    await chooseTheme(user, 'Light', 'System');
    expect(html.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
  });

  it('an explicit choice wins over the operating system', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    setSystemDark(true);
    await renderApp('/');
    expect(html.dataset.theme).toBe('light');
    expect(screen.getByRole('button', { name: 'Theme: Light' })).toBeInTheDocument();
  });

  it('still works when storage is unavailable (privacy mode)', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { user } = await renderApp('/');
    expect(html.dataset.theme).toBe('light');
    await chooseTheme(user, 'System', 'Dark');
    expect(html.dataset.theme).toBe('dark');
  });
});

describe('public/theme-init.js (runs before first paint)', () => {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- executes the real static file under test
  const run = () => (new Function(script) as () => void)();

  it.each([
    ['dark', false, 'dark'],
    ['light', true, 'light'],
    ['system', true, 'dark'],
    ['system', false, 'light'],
    ['nonsense', true, 'dark'],
    [null, false, 'light'],
  ])('stored %s with OS dark=%s → %s', (stored, osDark, expected) => {
    if (stored !== null) window.localStorage.setItem(THEME_STORAGE_KEY, stored);
    setSystemDark(osDark);
    run();
    expect(html.getAttribute('data-theme')).toBe(expected);
    expect(html.style.colorScheme).toBe(expected);
  });

  it('falls back to the system theme when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    setSystemDark(true);
    run();
    expect(html.getAttribute('data-theme')).toBe('dark');
  });

  it('uses the same storage key and media query as ThemeProvider', () => {
    expect(script).toContain(`'${THEME_STORAGE_KEY}'`);
    expect(script).toContain(`'${DARK_MEDIA_QUERY}'`);
  });
});
