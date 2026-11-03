import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  colorTokenNames,
  colors,
  contrastRatio,
  tailwindColorMap,
  tailwindThemeCss,
  themeNames,
  tokensCss,
  type ColorToken,
} from '../src/index.js';

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('generated CSS', () => {
  it.each([
    ['tokens.css', tokensCss],
    ['tailwind-theme.css', tailwindThemeCss],
  ])('%s is in sync with src/tokens.ts (run `npm run generate` after changing tokens)', (file, generate) => {
    expect(read(file)).toBe(generate());
  });

  it('removes the default Tailwind palette so only tokens can be used for colour', () => {
    expect(tailwindThemeCss()).toContain('--color-*: initial;');
  });

  it('maps every Tailwind colour utility to an existing token', () => {
    for (const [, token] of tailwindColorMap) expect(colorTokenNames).toContain(token);
  });
});

describe('token completeness', () => {
  it.each(themeNames)('%s theme defines every colour token with a valid value', (theme) => {
    for (const token of colorTokenNames) {
      expect(colors[theme][token], `${theme}.${token}`).toMatch(/^(#[0-9a-f]{6}|rgb\([\d ]+\/ [\d.]+\))$/);
    }
  });
});

describe('contrastRatio()', () => {
  it('matches known WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });
});

// WCAG 2.2 AA: text ≥ 4.5:1; UI component boundaries, focus indicators and presence dots ≥ 3:1.
const TEXT_PAIRS: [ColorToken, ColorToken[]][] = [
  ['text', ['bg', 'bg-subtle', 'surface', 'surface-raised', 'surface-hover', 'surface-selected']],
  ['text-muted', ['bg', 'bg-subtle', 'surface', 'surface-raised', 'surface-hover', 'surface-selected']],
  ['primary-fg', ['primary', 'primary-hover']],
  ['accent-fg', ['accent']],
  ['danger-fg', ['danger']],
  ['text-inverse', ['text']],
  ['primary', ['bg', 'bg-subtle', 'surface', 'surface-raised']],
  ['success', ['bg', 'bg-subtle', 'surface', 'surface-raised']],
  ['warning', ['bg', 'bg-subtle', 'surface', 'surface-raised']],
  ['danger', ['bg', 'bg-subtle', 'surface', 'surface-raised']],
  ['info', ['bg', 'bg-subtle', 'surface', 'surface-raised']],
];
const NON_TEXT_PAIRS: [ColorToken, ColorToken[]][] = [
  ['border-strong', ['bg', 'bg-subtle', 'surface', 'surface-raised']],
  ['focus-ring', ['bg', 'bg-subtle', 'surface', 'surface-raised', 'surface-hover', 'surface-selected']],
  ['presence-online', ['bg-subtle', 'surface', 'surface-raised']],
  ['presence-away', ['bg-subtle', 'surface', 'surface-raised']],
  ['presence-busy', ['bg-subtle', 'surface', 'surface-raised']],
  ['presence-dnd', ['bg-subtle', 'surface', 'surface-raised']],
  ['presence-offline', ['bg-subtle', 'surface', 'surface-raised']],
];

describe.each(themeNames)('%s theme contrast (WCAG 2.2 AA)', (theme) => {
  const failures = (pairs: [ColorToken, ColorToken[]][], minimum: number) =>
    pairs.flatMap(([fg, backgrounds]) =>
      backgrounds
        .map((bg) => ({ pair: `${fg} on ${bg}`, ratio: contrastRatio(colors[theme][fg], colors[theme][bg]) }))
        .filter(({ ratio }) => ratio < minimum)
        .map(({ pair, ratio }) => `${pair}: ${ratio.toFixed(2)}`),
    );

  it('text pairs reach 4.5:1', () => {
    expect(failures(TEXT_PAIRS, 4.5)).toEqual([]);
  });

  it('UI boundaries, focus ring and presence indicators reach 3:1', () => {
    expect(failures(NON_TEXT_PAIRS, 3)).toEqual([]);
  });
});
