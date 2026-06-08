# RD-Sync Design System

> Baseline design system for Hito 1 UX polish. This document is the single
> source of truth for tokens, components, and the lint guardrails that keep
> the codebase on-system. It is intentionally short — the code under
> `src/components/ui/` and `src/app/globals.css` is the executable spec.

**Spec:** engram `sdd/hito1-ux-polish/spec` (REQ-DS-001..004)
**Design:** engram `sdd/hito1-ux-polish/design`
**Tasks:** engram `sdd/hito1-ux-polish/tasks`

---

## 1. Tokens

All tokens live in `src/app/globals.css` inside a Tailwind v4 `@theme` block.
The hex values below are the canonical palette; component code MUST reference
tokens by class name (`bg-primary`, `text-foreground`, etc.) — never by hex.

### 1.1 Brand colors

| Token | Hex | Role |
|---|---|---|
| `--color-primary` | `#0F766E` | Teal — primary actions, brand accents |
| `--color-primary-foreground` | `#F0FDFA` | Text on primary surfaces |
| `--color-secondary` | `#1E3A8A` | Deep blue — secondary actions, info chrome |
| `--color-secondary-foreground` | `#DBEAFE` | Text on secondary surfaces |

### 1.2 Surface colors

| Token | Hex | Role |
|---|---|---|
| `--color-background` | `#020617` | Page background (dark) |
| `--color-foreground` | `#F8FAFC` | Default text on background |
| `--color-card` | `#0F172A` | Card / panel background |
| `--color-card-foreground` | `#F8FAFC` | Text on cards |
| `--color-popover` | `#0F172A` | Popover / dropdown background |
| `--color-popover-foreground` | `#F8FAFC` | Text on popovers |
| `--color-muted` | `#1E293B` | Muted surface (code blocks, subdued panels) |
| `--color-muted-foreground` | `#94A3B8` | Muted text (descriptions, metadata) |
| `--color-accent` | `#67E8F9` | Cyan accent (eyebrows, focus hints) |
| `--color-accent-foreground` | `#082F49` | Text on accent surfaces |
| `--color-border` | `#1E293B` | Default border |
| `--color-input` | `#334155` | Form input border |
| `--color-ring` | `#67E8F9` | Focus ring color (matches accent) |

### 1.3 Status colors

| Token | Hex | Role |
|---|---|---|
| `--color-destructive` | `#B91C1C` | Destructive actions (delete, revoke) |
| `--color-destructive-foreground` | `#FEF2F2` | Text on destructive surfaces |
| `--color-success` | `#10B981` | Success toasts, positive badges |
| `--color-warning` | `#F59E0B` | Warning toasts, attention badges |
| `--color-info` | `#0EA5E9` | Info toasts, neutral notifications |
| `--color-credit` | `#10B981` | Credit direction chip (revenue in) |
| `--color-debit` | `#F59E0B` | Debit direction chip (money out) |

> **Note:** Credit and Debit reuse the success/warning hues by design — they
> are semantic aliases so transaction chips and status badges can stay
> visually consistent.

### 1.4 Radius

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | `0.375rem` | Small UI (badges, chips, focus rings) |
| `--radius-md` | `0.5rem` | Default (buttons, inputs, cards) |
| `--radius-lg` | `0.75rem` | Large surfaces (modals, sheets) |

### 1.5 Typography

| Token | Value | Use |
|---|---|---|
| `--font-sans` | `"Inter", system-ui, sans-serif` | Default UI text |
| `--font-mono` | `"JetBrains Mono", ui-monospace, monospace` | Amounts, reference codes |

> **Note:** `next/font/google` wiring for Inter and JetBrains Mono is scoped
> to a follow-up commit; this change references the font families by name
> so the CSS is correct even before the Next.js font loader is wired.

### 1.6 Shadows

| Token | Value | Use |
|---|---|---|
| `--shadow-card` | `0 1px 2px 0 rgb(2 6 23 / 0.4)` | Subtle card lift |
| `--shadow-popover` | `0 8px 24px -8px rgb(2 6 23 / 0.6)` | Popover / dropdown lift |

---

## 2. Component inventory

All base components live in `src/components/ui/`. Each ships a Vitest test
that asserts it renders and applies the expected class names. Components
are reviewable TSX (shadcn/ui pattern) — not a black-box dependency.

| Component | File | Purpose |
|---|---|---|
| `Badge` | `src/components/ui/badge.tsx` | Status / label chip with variants |
| `Button` | `src/components/ui/button.tsx` | Action trigger (Radix Slot, CVA variants) |
| `Card` | `src/components/ui/card.tsx` | Surface container with header / body / footer |
| `Dialog` | `src/components/ui/dialog.tsx` | Modal dialog (Radix Dialog) |
| `Drawer` | `src/components/ui/drawer.tsx` | Side sheet (Radix Dialog in sheet mode) |
| `EmptyState` | `src/components/ui/empty-state.tsx` | Guided empty state with action slot |
| `ErrorState` | `src/components/ui/error-state.tsx` | Error fallback with retry slot |
| `Input` | `src/components/ui/input.tsx` | Text input with token-driven styling |
| `PageHeader` | `src/components/ui/page-header.tsx` | Standardized page title + description + actions |
| `Select` | `src/components/ui/select.tsx` | Dropdown select (Radix Select) |
| `Skeleton` | `src/components/ui/skeleton.tsx` | Loading placeholder with pulse |
| `Toaster` | `src/components/ui/toast.tsx` | Sonner toaster wrapper (dark theme) |
| `Tooltip` | `src/components/ui/tooltip.tsx` | Accessible tooltip (Radix Tooltip) |

> **Note:** The shadcn `sonner` add is wrapped in `src/components/ui/toast.tsx`
> so feature code imports a token-styled `Toaster` rather than the raw
> sonner component. PR B/C may introduce a dedicated `useToast` hook if
> imperative toast calls grow beyond the two stub paths in scope.

### 2.1 Conventions

- All components export a named function (no default exports) so the import
  site reads as a UI element, not an opaque module.
- All components accept a `className` prop and forward it to the root
  element via `cn()` (`src/lib/utils.ts`). Callers can override or extend
  styling without forking the component.
- Variant composition uses `class-variance-authority` for the components
  that need them (`Button`, `Badge`). Components without variants stay
  flat.

---

## 3. "No raw hex" rule (REQ-DS-001)

### 3.1 Why

A single hex literal in a component file silently re-introduces the legacy
raw-hex style we are removing. The rule makes the violation a build error
so the palette stays swappable from one file (`globals.css`).

### 3.2 The rule

`eslint.config.mjs` ships a flat-config block scoped to
`src/components/**/*.{ts,tsx}` and `src/app/**/page.tsx`:

```js
{
  files: ["src/components/**/*.{ts,tsx}", "src/app/**/page.tsx"],
  rules: {
    "no-restricted-syntax": [
      "error",
      {
        selector: "Literal[value=/^#[0-9A-Fa-f]{3,8}$/]",
        message:
          "Raw hex colors are forbidden in components and page entry points. " +
          "Use the design tokens from src/app/globals.css (e.g. `bg-primary`, " +
          "`text-foreground`) instead.",
      },
    ],
  },
}
```

### 3.3 Scope notes

- **`src/app/globals.css` is exempt.** Token definitions are the one place
  hex values are allowed.
- **Test files (`*.test.tsx`) are not excluded by the glob.** If a test
  needs a raw hex (e.g. a snapshot of a legacy style), refactor the test
  to assert on the token class instead of the computed color. The rule
  is correct as scoped; a test that violates it is asserting the wrong
  thing.
- **The `eslint.config.test.ts` suite** (in `src/`) verifies the rule's
  structure: the block exists, the selector matches the regex, and the
  scope does not target `.css` files. See the test file for the contract.

### 3.4 How to fix a violation

Replace the hex with the closest token class. Common mappings:

| Hex intent | Token class |
|---|---|
| Teal accent / brand | `bg-primary` / `text-primary` |
| Deep blue secondary | `bg-secondary` / `text-secondary` |
| Cyan accent / focus | `bg-accent` / `text-accent` |
| Neutral surface | `bg-card` / `bg-background` |
| Subdued text | `text-muted-foreground` |
| Default text | `text-foreground` |
| Border | `border-border` |
| Credit (money in) | `bg-success` / `text-success` |
| Debit (money out) | `bg-warning` / `text-warning` |
| Destructive | `bg-destructive` / `text-destructive` |

If a needed token is missing, add it to `@theme` in `globals.css` first —
do not inline a one-off hex.

---

## 4. Accessibility (REQ-DS-002)

### 4.1 Targets

- **WCAG 2.1 AA** contrast for all text on all token surfaces.
- All interactive elements reachable by keyboard, in DOM order, with a
  visible focus ring.
- All form controls have an associated label (`<label for>`, `aria-labelledby`,
  or wrapping label).
- Status and direction are **never** signaled by color alone — text or icon
  always accompanies the color.

### 4.2 Focus ring

Defined globally in `globals.css` `@layer base`:

```css
*:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}
```

The ring uses `--color-ring` (`#67E8F9`, cyan) at 2px solid with 2px
offset — visible on both dark and muted surfaces.

### 4.3 Reduced motion

`@media (prefers-reduced-motion: reduce)` globally disables
`animation` and `transition`. Sonner auto-honors this for toast slides.

### 4.4 Status non-color signals

- **Direction chip** — credit/debit uses `--color-credit` / `--color-debit`
  (emerald / amber) plus an `ArrowUp` / `ArrowDown` icon from `lucide-react`
  and the text "Credit" / "Debit". Landed in PR B.
- **Status badge** — review state and run status use color + text + icon.
  See `Badge` variants in `src/components/ui/badge.tsx`.

### 4.5 Mobile-friendly (REQ-DS-003)

- Minimum 44px touch target on primary actions.
- Filter toolbars collapse into a `Drawer` (Radix Dialog in sheet mode)
  below the `sm` breakpoint — landed in PR B.
- Layout uses a responsive grid that reflows to single-column at
  360px viewport.

---

## 5. Theme

**Dark only** for this change. The CSS sets `color-scheme: dark` on
`:root` and locks the palette to the tokens above. Light-mode slots are
intentionally not declared — flipping to light mode is a follow-up
change that will:

1. Add a `:root[data-theme="light"]` (or `prefers-color-scheme: light`)
   block with the light palette.
2. Wire a `data-theme` attribute (or media query) at the `<html>` level.
3. Re-run the a11y suite to confirm contrast holds in light mode.

The shadcn primitives are designed to be theme-agnostic, so the flip
should be a token-only change with no component refactors.

---

## 6. E2E fixture preservation (REQ-DS-004)

The existing Playwright E2E suite (`tests/e2e/rd-sync-flows.spec.ts`)
asserts on specific text strings. The new design preserves every
string in the DOM. The full list is in the design engram
(`sdd/hito1-ux-polish/design`, section 10). Highlights:

- `Recent transactions` (h1 on `/transactions`)
- `Transaction filters` (form `aria-label`)
- `No recent transactions are available` (empty h2)
- `Scrape run operations` (h1 on `/admin/scrape-runs`)
- `Admin intervention required` (h2)
- `Bank session requires admin MFA action` (run error)
- `Transaction dashboard MVP`, `Employee flow`, `Admin demo flow`
  (home page)

PR D adds an explicit `test("preserves fixture text across redesign")`
that asserts every string above resolves via `getByText` /
`getByRole`.

---

## 7. Out of scope (this change)

- Light mode (section 5) — follow-up.
- New components beyond the 13 in the inventory.
- Token renames or palette changes.
- Visual regression baselines (PR D).

---

## 8. References

- **Spec (delta):** `sdd/hito1-ux-polish/spec` — REQ-DS-001..004, REQ-TX-UX-*,
  REQ-OPS-UX-*, REQ-AUD-UX-001.
- **Design:** `sdd/hito1-ux-polish/design` — file layout, component trees,
  E2E preservation table, risk register.
- **Tasks:** `sdd/hito1-ux-polish/tasks` — PR A..D breakdown, chain strategy.
- **Decisions:** `sdd/rd-sync/hito1-ux-polish-decisions` — direction A
  (shadcn/ui + Tailwind v4), teal #0F766E + deep blue #1E3A8A, dark only,
  FR-011/FR-012 honest stubs.
- **Canonical specs (unchanged):** `transaction-dashboard`, `operations-monitoring`,
  `access-control-audit` — the delta does not modify their capability
  boundaries.
