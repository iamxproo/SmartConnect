# @smartconnect/design-tokens

Single source of truth for SmartConnect design tokens ([design-system.md](../../../docs/architecture/design-system.md)).

| File | Role |
|---|---|
| `src/tokens.ts` | **Edit here.** Colours (light/dark), shadows, typography, radius, z-index, motion |
| `tokens.css` | Generated. `--sc-*` CSS variables. `data-theme="light|dark"` selects the mode; no-JS falls back to the OS; durations become `0ms` under `prefers-reduced-motion` |
| `tailwind-theme.css` | Generated. Tailwind v4 `@theme inline` mapping; **removes Tailwind's default palette** |

After changing tokens:

```bash
npm run generate --workspace @smartconnect/design-tokens
npm run test --workspace @smartconnect/design-tokens
```

**Tests:**
- **Drift:** the committed CSS equals the generator output.
- **Completeness:** every token is defined in both themes.
- **WCAG 2.2 AA contrast:** text pairs ≥ 4.5:1; input borders, focus ring and presence dots ≥ 3:1.

**Palette status:** **provisional neutral palette.** Brand identity is an open product decision. Rebranding changes values in `tokens.ts` only; the contrast tests guard any new values.

## Tailwind utility names

Utilities follow the shadcn/ui vocabulary, so vendored primitives work unchanged:

| Utility colour | Token | Utility colour | Token |
|---|---|---|---|
| `background` | `bg` | `muted` | `bg-subtle` |
| `foreground` | `text` | `muted-foreground` | `text-muted` |
| `subtle` | `bg-subtle` | `accent` / `accent-foreground` | `surface-hover` / `text` (**interactive highlight**, shadcn semantics) |
| `surface`, `surface-raised`, `surface-hover`, `surface-selected` | same names | `brand-accent` / `brand-accent-foreground` | `accent` / `accent-fg` (brand accent) |
| `card` | `surface` | `destructive` / `destructive-foreground` | `danger` / `danger-fg` |
| `popover` | `surface-raised` | `success`, `warning`, `danger`, `info` | same names |
| `primary`, `primary-hover`, `primary-foreground` | `primary`, `primary-hover`, `primary-fg` | `border`, `border-strong`, `input` | `border`, `border-strong`, `border-strong` |
| `secondary` | `bg-subtle` | `ring` | `focus-ring` |
| `inverse` | `text-inverse` | `presence-online|away|busy|dnd|offline` | same names |
| `overlay` | `overlay` | | |

Also mapped: `font-sans`/`font-mono`, text sizes `xs … 3xl` (body `base` = 0.875rem; `md` = 1rem), `rounded-sm|md|lg|xl|full`, `shadow-sm|md|lg`, `ease-standard|enter|exit`. Durations and z-index are CSS variables: `duration-(--sc-duration-fast)`, `z-(--sc-z-modal)`.

Mobile (Phase 6) will consume `src/tokens.ts` directly.
