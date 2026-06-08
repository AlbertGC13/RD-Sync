/**
 * Accessibility smoke checks (REQ-DS-002).
 *
 * Lightweight Vitest suite that reads the source files of the redesigned
 * pages and asserts on a few of the most common a11y pitfalls. It is NOT a
 * replacement for axe-core or a full audit, but it catches regressions
 * where a new component drops a focus ring, an aria-label, or a semantic
 * element.
 *
 * For deep a11y testing, add `@axe-core/playwright` to the Playwright
 * suite in a follow-up change.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();

function readSource(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

describe("A11y smoke checks (REQ-DS-002)", () => {
  it("the global focus ring rule is present in globals.css", () => {
    const css = readSource("src/app/globals.css");
    expect(css).toMatch(/focus-visible\s*{[^}]*outline/);
  });

  it("the transactions page is reachable as a route under (private)", () => {
    const page = readSource("src/app/(private)/transactions/page.tsx");
    // The page renders into the root layout's <main id="main">.
    expect(page).toContain("Recent transactions");
  });

  it("the admin scrape-runs page is reachable as a route under admin", () => {
    const page = readSource("src/app/admin/scrape-runs/page.tsx");
    expect(page).toContain("Scrape run operations");
  });

  it("review actions advertise themselves as disabled to assistive tech", () => {
    const component = readSource("src/components/transactions/review-actions.tsx");
    expect(component).toContain('aria-disabled="true"');
    expect(component).toContain("disabled");
    expect(component).toContain('role="group"');
  });

  it("run action affordances advertise themselves as disabled to assistive tech", () => {
    const component = readSource("src/components/admin/run-action-affordances.tsx");
    expect(component).toContain('aria-disabled="true"');
    expect(component).toContain("disabled");
    expect(component).toContain("role=\"group\"");
  });

  it("no design system component includes a raw hex color (lint covers the same)", () => {
    const components = [
      "src/components/ui/button.tsx",
      "src/components/ui/card.tsx",
      "src/components/ui/badge.tsx",
      "src/components/ui/skeleton.tsx",
      "src/components/ui/input.tsx",
      "src/components/ui/select.tsx",
      "src/components/ui/tooltip.tsx",
      "src/components/ui/toast.tsx",
      "src/components/ui/dialog.tsx",
      "src/components/ui/drawer.tsx",
      "src/components/ui/empty-state.tsx",
      "src/components/ui/error-state.tsx",
      "src/components/ui/page-header.tsx",
    ];
    for (const path of components) {
      const source = readSource(path);
      expect(source, `${path} must not use raw hex colors`).not.toMatch(/#[0-9A-Fa-f]{3,8}/);
    }
  });
});
