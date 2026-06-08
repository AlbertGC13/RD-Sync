/**
 * E2E fixture preservation contract (REQ-DS-004).
 *
 * The Playwright suite in `tests/e2e/rd-sync-flows.spec.ts` asserts on a
 * specific set of literal text strings rendered in the DOM. Any redesign
 * of the transactions dashboard or the admin scrape-runs page MUST keep
 * those strings in the rendered HTML, or the suite breaks.
 *
 * This unit test walks the page source files and checks that each
 * expected string is still present. It does not require a running
 * browser; it is a static guard that runs in milliseconds on every CI
 * run, before the slower Playwright suite.
 *
 * If you intentionally rename any of these strings, update both this
 * test AND the corresponding `expect(...)` in
 * `tests/e2e/rd-sync-flows.spec.ts` in the same commit.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();

type FixtureString = {
  /** Human description of what the string means in the user flow. */
  description: string;
  /** File that must contain the literal string. */
  file: string;
  /** The exact literal expected in the file. */
  literal: string;
};

/**
 * Locked list (REQ-DS-004). Keep in sync with the Playwright suite.
 */
const FIXTURES: FixtureString[] = [
  // ---- Transactions dashboard (employee) ----
  {
    description: "Transactions page heading is reachable for screen readers and Playwright heading role.",
    file: "src/app/(private)/transactions/page.tsx",
    literal: "Recent transactions",
  },
  {
    description: "Filter form is labelled for assistive tech and the E2E form role.",
    file: "src/components/transactions/filter-bar.tsx",
    literal: 'aria-label="Transaction filters"',
  },
  {
    description: "Empty state copy is checked by the E2E suite.",
    file: "src/app/(private)/transactions/page.tsx",
    literal: "No recent transactions are available",
  },
  {
    description: "Filter section header replaces the old 'Filter by bank' label.",
    file: "src/components/transactions/filter-bar.tsx",
    literal: "Filter transactions",
  },

  // ---- Admin scrape-runs ----
  {
    description: "Admin page heading is the E2E heading role target.",
    file: "src/app/admin/scrape-runs/page.tsx",
    literal: "Scrape run operations",
  },
  {
    description: "Admin intervention card title is asserted on in the E2E suite.",
    file: "src/app/admin/scrape-runs/page.tsx",
    literal: "Admin intervention required",
  },
  {
    description: "Recovery checklist step (full sentence) is asserted on in the E2E suite.",
    file: "src/app/admin/scrape-runs/page.tsx",
    literal:
      "Resume only after session renewal is completed by an admin.",
  },
  {
    description: "Safe-failure checklist preamble is asserted on in the E2E suite.",
    file: "src/app/admin/scrape-runs/page.tsx",
    literal:
      "Confirm the alert contains no credentials, cookies, or raw bank session data.",
  },
  {
    description: "Bank-name humanization for Banreservas is in the admin run card.",
    file: "src/app/admin/scrape-runs/page.tsx",
    literal: "Banreservas",
  },
];

describe("E2E fixture preservation (REQ-DS-004)", () => {
  for (const fixture of FIXTURES) {
    it(`preserves "${fixture.literal.slice(0, 40)}..." in ${fixture.file}`, () => {
      const fullPath = join(REPO_ROOT, fixture.file);
      const source = readFileSync(fullPath, "utf8");
      expect(source, `${fixture.description}`).toContain(fixture.literal);
    });
  }

  it("the Playwright suite itself has not lost its role/text selectors", () => {
    const specPath = join(REPO_ROOT, "tests/e2e/rd-sync-flows.spec.ts");
    const spec = readFileSync(specPath, "utf8");
    expect(spec).toMatch(/getByRole\(['"]heading['"],\s*\{\s*name:\s*['"]Recent transactions['"]/);
    expect(spec).toMatch(/getByRole\(['"]heading['"],\s*\{\s*name:\s*['"]Scrape run operations['"]/);
    expect(spec).toMatch(/getByText\(['"]Admin intervention required['"]/);
    expect(spec).toMatch(/getByText\(['"]No recent transactions are available['"]/);
    expect(spec).toContain("Resume only after session renewal is completed by an admin.");
  });
});
