// axe-core in the real browser: injected into the page under test, run on what is rendered right now.
import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';

const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

export interface AxeViolation {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical' | null;
  help: string;
  nodes: { target: string[]; html: string }[];
}

export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** Pages read the theme from this key before first paint (src/lib/theme.tsx). Set it before navigating. */
export const useTheme = (page: Page, theme: Theme) =>
  page.context().addInitScript((value) => localStorage.setItem('sc-theme', value), theme);

/** Runs axe on the current page, waits for entrance animations to settle first, and logs every violation. */
export async function axeViolations(
  page: Page,
  label: string,
  theme: Theme,
  rules?: string[],
): Promise<AxeViolation[]> {
  await page.waitForTimeout(1_200); // entrance animations: axe reads colors of what is painted
  const actual = await page.evaluate('document.documentElement.dataset.theme');
  if (actual !== theme) throw new Error(`expected the ${theme} theme on ${label}, the page is ${String(actual)}`);
  await page.addScriptTag({ path: axePath });
  const violations = await page.evaluate<AxeViolation[]>(
    `axe.run(document, ${JSON.stringify(rules ? { runOnly: rules } : {})}).then((result) => result.violations)`,
  );
  for (const violation of violations) {
    const where = violation.nodes.map((node) => `${node.target.join(' ')} ${node.html.slice(0, 240)}`).join(' | ');
    console.log(`[axe] ${theme} ${label}: ${violation.id} (${violation.impact}) ${violation.help} -> ${where}`);
  }
  return violations;
}

export const blocking = (violations: AxeViolation[]) =>
  violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
