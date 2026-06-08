# RD-Sync Design System Baseline

This document captures the design system introduced in Hito 1 UX polish
(commit chain `feat/hito1-ux-polish-*`, starting at
`feat/hito1-ux-polish-ds-baseline`). It is the source of truth for
component reuse, color usage, and accessibility expectations across the
employee and admin surfaces.

## 1. Stack

- **Tailwind v4** with CSS-first config (no `tailwind.config.ts`).
- **shadcn/ui** (New York style, neutral base) as the component library.
- **Sonner** for toasts (matches shadcn/ui default).
- **lucide-react** for icons.
- **class-variance-authority + clsx + tailwind-merge** for variant composition
  via the shared `cn()` helper at `src/lib/utils.ts`.
- **Radix UI primitives** (dialog, tooltip, select, dropdown-menu, popover,
  slot) under the hood of shadcn/ui components.

## 2. Design tokens

All design tokens live in the `@theme` block of `src/app/globals.css`. They
are CSS variables consumed by Tailwind v4 utility classes (e.g.
`bg-primary`, `text-foreground`, `border-border`).

| Token | Value | Use |
| --- | --- | --- |
| `--color-background` | `#020617` | Page background |
| `--color-foreground` | `#f8fafc` | Default text |
| `--color-card` | `#0f172a` | Card surfaces |
| `--color-card-foreground` | `#f8fafc` | Card text |
| `--color-popover` | `#0f172a` | Popover surfaces |
| `--color-popover-foreground` | `#f8fafc` | Popover text |
| `--color-primary` | `#0f766e` | Brand primary (teal) |
| `--color-primary-foreground` | `#f0fdfa` | Text on primary |
| `--color-secondary` | `#1e3a8a` | Brand secondary (deep blue) |
| `--color-secondary-foreground` | `#dbeafe` | Text on secondary |
| `--color-muted` | `#1e293b` | Muted surfaces |
| `--color-muted-foreground` | `#94a3b8` | Muted text |
| `--color-accent` | `#67e8f9` | Accent highlights |
| `--color-accent-foreground` | `#082f49` | Text on accent |
| `--color-destructive` | `#b91c1c` | Destructive actions |
| `--color-destructive-foreground` | `#fef2f2` | Text on destructive |
| `--color-success` | `#10b981` | Success states |
| `--color-warning` | `#f59e0b` | Warning states |
| `--color-info` | `#0ea5e9` | Info states |
| `--color-credit` | `#10b981` | Credit transaction badge |
| `--color-debit` | `#f59e0b` | Debit transaction badge |
| `--color-border` | `#1e293b` | Default borders |
| `--color-input` | `#334155` | Input borders |
| `--color-ring` | `#67e8f9` | Focus ring |
| `--radius-sm` | `0.375rem` | Small radius |
| `--radius-md` | `0.5rem` | Medium radius |
| `--radius-lg` | `0.75rem` | Large radius |
| `--font-sans` | `"Inter", system-ui, sans-serif` | UI text |
| `--font-mono` | `"JetBrains Mono", ui-monospace, monospace` | Code |
| `--shadow-card` | `0 1px 2px 0 rgb(2 6 23 / 0.4)` | Card elevation |
| `--shadow-popover` | `0 8px 24px -8px rgb(2 6 23 / 0.6)` | Popover elevation |

## 3. Component inventory

Base components live under `src/components/ui/` and are exported by name.
Each has a paired `.test.tsx` and is built on shadcn/ui patterns.

| Component | File | Notes |
| --- | --- | --- |
| `Button` | `src/components/ui/button.tsx` | cva variants: default, secondary, destructive, outline, ghost, link. |
| `Card` | `src/components/ui/card.tsx` | Header / content / footer slots. |
| `Badge` | `src/components/ui/badge.tsx` | Used for credit/debit indicators, run status. |
| `Skeleton` | `src/components/ui/skeleton.tsx` | Loading state placeholder. |
| `Input` | `src/components/ui/input.tsx` | Styled form input. |
| `Select` | `src/components/ui/select.tsx` | Radix `Select` wrapper. |
| `Tooltip` | `src/components/ui/tooltip.tsx` | Radix `Tooltip` wrapper, used for FR-011/FR-012 stubs. |
| `Toast` | `src/components/ui/toast.tsx` | Sonner `Toaster` re-export with theme. |
| `Dialog` | `src/components/ui/dialog.tsx` | Radix `Dialog` wrapper. |
| `Drawer` | `src/components/ui/drawer.tsx` | Mobile-friendly side sheet. |
| `EmptyState` | `src/components/ui/empty-state.tsx` | Consistent empty-state pattern. |
| `ErrorState` | `src/components/ui/error-state.tsx` | Consistent error-state pattern. |
| `PageHeader` | `src/components/ui/page-header.tsx` | Shared page header. |

## 4. "No raw hex" rule

Components and top-level page entry points MUST NOT use raw hex colors.
The design system enforces this via an ESLint flat-config rule defined in
`eslint.config.mjs` (block scoped to `src/components/**/*.{ts,tsx}` and
`src/app/**/page.tsx`, excluding `*.test.{ts,tsx}` and `page.test.tsx` so
test fixtures can exercise the rule). When a violation is found, the lint
output reads:

> Raw hex colors are forbidden in components and page entry points. Use the
> design tokens from src/app/globals.css (e.g. `bg-primary`,
> `text-foreground`) instead.

Use Tailwind utility classes that resolve to the CSS variables, e.g.
`bg-primary`, `text-foreground`, `border-border`, `text-credit`,
`bg-debit/20`. For one-off values, prefer extending the `@theme` block in
`globals.css` over inlining a color.

## 5. Accessibility

- **WCAG 2.1 AA**: every redesigned page must meet color contrast and
  focus visibility requirements.
- **Focus rings**: the global `*:focus-visible` rule in `globals.css` uses
  `outline: 2px solid var(--color-ring); outline-offset: 2px`. Do not
  suppress focus rings without a replacement.
- **Semantic HTML**: prefer native elements (`<button>`, `<a>`, `<nav>`,
  `<section>`) over `div` + role attributes.
- **ARIA labels**: every nav, dialog, and form control must have an
  associated label. The Sonner `Toaster` exposes its mount point with
  `aria-label="Notifications..."`.
- **Color is not the only signal**: status badges (credit/debit, run
  status) pair color with text and an icon. This protects color-blind
  users.
- **Reduced motion**: the global `@media (prefers-reduced-motion: reduce)`
  block disables animations and transitions for users who request it.
  Sonner toasts respect this preference by default.

## 6. Theme

This change ships **dark mode only**. The `@theme` block defines dark
values directly. Light-mode slots are placeholders for a future change
that can be enabled with a one-line theme switch.

## 7. Out of scope (carried over)

- Light mode (deferred to a follow-up; the token block can be extended
  without changing consumer code).
- Replacing in-memory repositories with Prisma runtime (separate change).
- Real bank integration (Hito 2, separate change).
- Email parser fallback (Hito 5).
- ERP connector (Hito 6).

## 8. References

- PRD: `docs/prd-rd-sync-producto-final.md`
- Spec delta: Engram topic `sdd/hito1-ux-polish/spec`
- Design: Engram topic `sdd/hito1-ux-polish/design`
- Task breakdown: Engram topic `sdd/hito1-ux-polish/tasks`
- Executive decisions: Engram topic `sdd/rd-sync/hito1-ux-polish-decisions`
