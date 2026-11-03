# Design system foundations

Status: **Implemented in Phase 1 Task 1** (`smartconnect-frontend/packages/design-tokens`, `packages/ui`, `web`), with a **provisional neutral palette**. Brand identity (palette hues, typeface, logo, illustration style) is an open product decision. Everything below is structured so the brand can be applied by changing token values only.

## Principles

1. **Clarity at density.** A communication tool shows a lot of information at once: hierarchy comes from type and spacing before colour.
2. **Accessible by default.** WCAG 2.2 AA, complete keyboard operation, screen-reader support, `prefers-reduced-motion` respected everywhere.
3. **Motion explains, never decorates.** Every animation communicates a state change (arrived, moved, opened, completed).
4. **One source of tokens** for web and mobile.

## Architecture

| Layer | Location | Notes |
|---|---|---|
| Design tokens | `smartconnect-frontend/packages/design-tokens` | Platform-neutral source (TypeScript object). Emitted as CSS variables for web (Tailwind v4 `@theme`) and as a theme object for React Native (Phase 6) |
| Web primitives | `smartconnect-frontend/packages/ui` | shadcn/ui components (Radix-based) themed with the tokens; owned code, not a dependency |
| Product components | `smartconnect-frontend/web/src/components` | Composed from primitives (message list, composer, call tiles) |

Theme modes: light, dark and system, switched by a `data-theme` attribute, with no flash on load. High-contrast mode is planned after Phase 2.

## Tokens

| Group | Tokens |
|---|---|
| **Colour (semantic, never raw hex in components)** | `bg`, `bg-subtle`, `surface`, `surface-raised`, `surface-hover`, `surface-selected`, `overlay`, `border`, `border-strong`, `text`, `text-muted`, `text-inverse`, `primary` (+ `-hover`, `-fg`), `accent` (+ `-fg`), `success`, `warning`, `danger` (+ `-fg`), `info`, `focus-ring`; presence: `presence-online`, `presence-away`, `presence-busy`, `presence-dnd`, `presence-offline`. (`surface-hover`, `surface-selected`, `accent-fg`, `danger-fg` were added during implementation: interactive states and text on coloured fills) |
| **Typography** | Sans for UI and mono for code. Scale (rem): 0.75 / 0.8125 / 0.875 (body) / 1 / 1.125 / 1.25 / 1.5 / 1.875; line heights 1.25 (headings) and 1.5 (body); weights 400 / 500 / 600 |
| **Spacing** | 4 px grid: 0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64 |
| **Radius** | `sm` 4, `md` 6, `lg` 8, `xl` 12, `full` |
| **Elevation** | `shadow-sm` (cards), `shadow-md` (popovers), `shadow-lg` (dialogs); dark mode uses surface steps more than shadows |
| **Z-index layers** | base 0, sticky 10, dropdown 20, overlay 30, modal 40, toast 50, call-overlay 60 |
| **Breakpoints** | `sm` 640, `md` 768, `lg` 1024, `xl` 1280, `2xl` 1536 |
| **Motion** | Durations: `instant` 80 ms, `fast` 120 ms, `base` 200 ms, `slow` 320 ms. Easings: `standard` cubic-bezier(0.2, 0, 0, 1), `enter` (0, 0, 0, 1), `exit` (0.3, 0, 1, 1); `spring` (Motion: stiffness 400, damping 35) for drag and layout |

Contrast requirement: text ≥ 4.5:1 and large text / UI boundaries ≥ 3:1, in both themes. **Verified per token pair by automated tests** (`packages/design-tokens/test/tokens.test.ts`, run in CI). Minimums with the provisional palette: muted text 5.27:1, status text 5.20:1, input borders and presence dots 3.49:1.

**In Tailwind** the tokens are exposed with shadcn/ui names (`bg-background`, `text-muted-foreground`, `accent` = interactive highlight, `brand-accent` = brand accent), and Tailwind's default palette is removed so raw colours cannot be used. Full mapping: [design-tokens README](../../smartconnect-frontend/packages/design-tokens/README.md#tailwind-utility-names).

## Motion guidelines

| Use | Tool |
|---|---|
| Enter/exit, layout changes, shared-element transitions, gestures, lists | **Motion for React** (`motion/react`): `AnimatePresence`, `layout`, `useReducedMotion` |
| Complex multi-step timelines or scroll-driven sequences (onboarding, marketing-style surfaces) | **GSAP**, only after licence sign-off ([ADR 0003](../decisions/0003-web-frontend-stack.md)) |

Rules:
- **Animate cheaply:** only `transform` and `opacity` (plus `filter` sparingly). Never animate layout-triggering properties on large lists.
- **Interruptible:** any animation may be interrupted. Rapid events (incoming messages) coalesce instead of queueing.
- **Reduced motion:** `prefers-reduced-motion: reduce` means no translation or scale. State changes use opacity fades of ≤ 120 ms or are instant. Typing and active-speaker indicators become static.
- **Virtualise:** long lists (messages, members, files) are virtualised; animations apply only to items entering the viewport.
- **Budget:** no interaction may drop below 60 fps on a mid-range laptop. Measured with the Performance panel during Phase 2 reviews.

## Interaction patterns (blueprint §7)

| Pattern | Specification |
|---|---|
| Navigation transitions | Route content cross-fades (`fast`); sidebar selection indicator uses a `layout` animation |
| Sidebar | Collapse/expand width with `base` + `standard`; persists per user |
| Message entrance | New message fades and rises 4 px (`fast`, `enter`); own sent messages appear instantly in "pending" style, then settle |
| Reactions | Count change scales 1 → 1.15 → 1 (`fast`, spring); reduced motion: no scale |
| Thread panel | Slides from the right (`base`); focus moves to the thread composer |
| Typing indicator | Three-dot pulse (static dots with reduced motion); `aria-live="polite"` text "X is typing" |
| Meeting participants | Tile grid uses `layout` animations as people join or leave; active speaker gets a 2 px `primary` ring transition (`fast`) |
| File upload | Determinate progress bar from upload events; cancel, retry and error states; drag-and-drop zone highlights on drag-over |
| Toasts | Bottom-right stack, max 3 visible, 5 s auto-dismiss (pausable on hover/focus), `role="status"`; errors use `role="alert"` and do not auto-dismiss |
| Skeleton loaders | Shown after 150 ms only (avoid flashes); shimmer disabled with reduced motion |
| Mobile gestures (Phase 6) | Reanimated + Gesture Handler: swipe to reply, long-press for reactions, pull to refresh |

## Accessibility requirements

- **Keyboard:**
  - Every action is reachable by keyboard, with visible focus rings (`focus-ring` token, 2 px).
  - `Ctrl/⌘ K` opens the command palette.
  - Arrow keys navigate the message list.
- **Screen readers:**
  - The message list is a feed (`role="feed"`); new messages are announced politely and not repeated on resync.
  - Dialogs trap focus and restore it on close.
  - Icons have labels; presence and status are never conveyed by colour alone (shape or text too).
- **Verification:** automated axe checks in component tests and Playwright, plus a manual screen-reader pass per phase (VoiceOver and NVDA).

## Component inventory (Phases 1–2)

AppShell, Sidebar (workspaces, channels, DMs), CommandPalette, Avatar + PresenceBadge, ChannelHeader, MessageList (virtualised), Message (thread summary, reactions, attachments), Composer (mentions, emoji, attachments, drafts), ThreadPanel, MemberList, InviteDialog, SettingsLayout, Toast, Dialog, Popover, DropdownMenu, Tooltip, Skeleton, EmptyState, ErrorBoundary view, UploadProgress.

## Open decisions

1. Brand identity: primary and accent hues, typeface (licensed or open; Inter-class sans recommended for UI density), logo.
2. Whether a designer-owned Figma library mirrors these tokens (recommended; token names above are the shared vocabulary).
