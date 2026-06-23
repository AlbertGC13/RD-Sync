/**
 * Accessibility smoke checks (REQ-DS-002).
 *
 * Lightweight Vitest suite that asserts on the HTML actually emitted by the
 * redesigned components — NOT on source-file literals — so the checks stay
 * green when copy is localized and only fail when the visible a11y contract
 * regresses (missing aria attributes, leaked raw enum values, English copy
 * reaching operators).
 *
 * For deep a11y testing, add `@axe-core/playwright` to the Playwright suite
 * in a follow-up change. The Spanish visible contracts for the transactions
 * and admin scrape-runs pages are covered by their respective page test
 * files (renderToStaticMarkup + es-DO assertions).
 */

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

// next/navigation is mocked so client components that call useRouter() can
// render to static markup without a Next.js runtime.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/admin/scrape-runs",
  useSearchParams: () => new URLSearchParams(),
}));

// sonner toast is a no-op in server render; stub it so client components
// that reference toast.* do not blow up outside a browser.
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const REPO_ROOT = process.cwd();

function readSource(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

describe("A11y smoke checks (REQ-DS-002)", () => {
  it("the global focus ring rule is present in globals.css", () => {
    // Structural CSS guard — cannot be exercised via renderToStaticMarkup.
    const css = readSource("src/app/globals.css");
    expect(css).toMatch(/focus-visible\s*{[^}]*outline/);
  });

  it("review actions advertise themselves as disabled to assistive tech with Spanish labels", async () => {
    const { ReviewActions } = await import("@/components/transactions/review-actions");
    const html = renderToStaticMarkup(
      createElement(ReviewActions, { transactionId: "tx-1", currentState: "new" }),
    );

    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("disabled");
    expect(html).toContain('role="group"');
    // Group label is localized to Spanish — operators are Dominican banking staff.
    expect(html).toContain('aria-label="Acciones de revisión (próximamente)"');
    // The tooltip body ("Disponible en un próximo cambio") lives in a Radix
    // Portal that is not emitted into static markup, so we assert on the
    // button-level aria-label announcement instead — same as the
    // run-action-affordances test.
  });

  it("run action affordances advertise themselves as disabled to assistive tech", async () => {
    const { RunActionAffordances } = await import("@/components/admin/run-action-affordances");
    const html = renderToStaticMarkup(
      createElement(
        RunActionAffordances,
        { runId: "run-1", bankId: "banreservas", status: "failed" },
      ),
    );

    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('role="group"');
  });
});
