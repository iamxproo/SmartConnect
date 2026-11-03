// Writes tokens.css and tailwind-theme.css from src/tokens.ts. Run after changing any token.
import { writeFileSync } from 'node:fs';
import { tailwindThemeCss, tokensCss } from '../src/css.js';

const root = new URL('../', import.meta.url);
writeFileSync(new URL('tokens.css', root), tokensCss());
writeFileSync(new URL('tailwind-theme.css', root), tailwindThemeCss());
console.log('✔ wrote tokens.css and tailwind-theme.css');
