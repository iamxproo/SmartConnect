# @smartconnect/ui

Web UI primitives in **shadcn/ui conventions**:
- **Radix primitives** from the `radix-ui` package, for accessible behaviour (focus management, keyboard, ARIA).
- **`cva` variants** and the **`cn()`** class merger.
- **`data-slot`** attributes.

They're styled only with design-token utilities ([design-tokens](../design-tokens/README.md)). The code is owned here and consumed as TypeScript source; there's no build step.

| Component | File |
|---|---|
| Button (variants: default, secondary, outline, ghost, destructive, link; `asChild`; defaults to `type="button"`) | `src/components/button.tsx` |
| DropdownMenu (items, labels, separators, radio items) | `src/components/dropdown-menu.tsx` |
| Tooltip | `src/components/tooltip.tsx` |
| Sheet (Radix Dialog side panel: focus trap, Escape, focus return) | `src/components/sheet.tsx` |
| Avatar, Separator, Skeleton | `src/components/*.tsx` |
| `cn()` (knows the custom `text-md` size and easings) | `src/lib/utils.ts` |

**Usage:**
- Import components with `import { Button } from '@smartconnect/ui/components/button'`.
- The app stylesheet must `@import '@smartconnect/ui/styles.css'`. It registers the components as a Tailwind source and defines their token-timed animations.

**shadcn CLI:**
- `components.json` validates against the official schema (`style: new-york`, aliases under `@smartconnect/ui/*`).
- Generated components must be reviewed for raw colours. Tailwind's default palette is disabled, so they fail to compile until mapped to tokens.
- The CLI itself has not been run in this repository yet.

Tests: `npm run test --workspace @smartconnect/ui`.
