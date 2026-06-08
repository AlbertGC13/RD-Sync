import { renderToStaticMarkup } from "react-dom/server";
import { headers } from "next/headers";
import { describe, expect, it, vi } from "vitest";

import {
  default as AdminScrapeRunsPage,
  AdminScrapeRunsDashboard,
  resolvePreviewPrincipal,
  summarizeScrapeRuns,
  type AdminScrapeRun,
} from "./page";

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

const runs: AdminScrapeRun[] = [
  {
    id: "run-1",
    bankId: "popular",
    status: "needs_admin_action",
    startedAt: "2026-06-07T13:45:00.000Z",
    endedAt: "2026-06-07T13:46:00.000Z",
    insertedCount: 0,
    skippedCount: 0,
    safeErrorSummary: "Bank session requires admin MFA action",
  },
  {
    id: "run-2",
    bankId: "banreservas",
    status: "succeeded",
    startedAt: "2026-06-07T12:00:00.000Z",
    endedAt: "2026-06-07T12:02:00.000Z",
    insertedCount: 12,
    skippedCount: 3,
    safeErrorSummary: null,
  },
  {
    id: "run-3",
    bankId: "bhd",
    status: "failed",
    startedAt: "2026-06-07T11:00:00.000Z",
    endedAt: "2026-06-07T11:01:00.000Z",
    insertedCount: 0,
    skippedCount: 0,
    safeErrorSummary: "Transaction table selector missing",
  },
];

describe("AdminScrapeRunsDashboard", () => {
  it("does not render hard-coded preview runs from the page when local preview is disabled", async () => {
    const previousValue = process.env.RD_SYNC_DEV_PREVIEW;
    vi.mocked(headers).mockResolvedValue(
      new Headers({
        "x-rd-sync-user-id": "admin-1",
        "x-rd-sync-role": "admin",
      }) as never,
    );

    try {
      delete process.env.RD_SYNC_DEV_PREVIEW;

      const html = renderToStaticMarkup(
        await AdminScrapeRunsPage({ searchParams: Promise.resolve({}) }),
      );

      expect(html).toContain("No scrape runs recorded yet");
      expect(html).not.toContain("Bank session requires admin MFA action");
      expect(html).not.toContain("preview-run-");
    } finally {
      vi.mocked(headers).mockReset();
      if (previousValue === undefined) {
        delete process.env.RD_SYNC_DEV_PREVIEW;
      } else {
        process.env.RD_SYNC_DEV_PREVIEW = previousValue;
      }
    }
  });

  it("renders operational health and admin intervention guidance for admins", () => {
    const html = renderToStaticMarkup(
      <AdminScrapeRunsDashboard principal={{ id: "admin-1", role: "admin" }} runs={runs} />,
    );

    // E2E fixture strings (REQ-DS-004 contract):
    expect(html).toContain("Scrape run operations");
    expect(html).toContain("Needs admin action");
    expect(html).toContain("1");
    expect(html).toContain("Bank session requires admin MFA action");
    expect(html).toContain("Admin intervention required");
    expect(html).toContain("Resume only after session renewal is completed by an admin.");
    expect(html).toContain("Banreservas");
    expect(html).toContain("12 inserted");
    // Negative guarantees: no secrets in the rendered HTML.
    expect(html).not.toContain("token=");
    expect(html).not.toContain("password=");
  });

  it("denies non-admin users without showing scraper controls or run details", () => {
    const html = renderToStaticMarkup(
      <AdminScrapeRunsDashboard principal={{ id: "viewer-1", role: "viewer" }} runs={runs} />,
    );

    expect(html).toContain("Admin access required");
    expect(html).toContain("Only admins can view scraping health or handle MFA/session intervention.");
    expect(html).not.toContain("Bank session requires admin MFA action");
    expect(html).not.toContain("Resume only after session renewal");
  });

  it("summarizes failed, succeeded, and attention-needed runs", () => {
    expect(summarizeScrapeRuns(runs)).toEqual({
      total: 3,
      succeeded: 1,
      failed: 1,
      needsAdminAction: 1,
      inserted: 12,
      skipped: 3,
    });
  });

  it("renders an honest empty state when no real scrape runs are recorded", () => {
    const html = renderToStaticMarkup(
      <AdminScrapeRunsDashboard principal={{ id: "admin-1", role: "admin" }} runs={[]} />,
    );

    expect(html).toContain("No scrape runs recorded yet");
    expect(html).toContain("Once a bank connection is wired and the scheduler is on, runs will appear here.");
    expect(html).not.toContain("Bank session requires admin MFA action");
  });

  it("exposes FR-012 affordances (Retry, Disable, Renew) as disabled stubs", () => {
    const html = renderToStaticMarkup(
      <AdminScrapeRunsDashboard principal={{ id: "admin-1", role: "admin" }} runs={runs} />,
    );

    expect(html).toContain("Retry run");
    expect(html).toContain("Disable connection");
    expect(html).toContain("Renew session");
    expect(html).toContain('aria-label="Run actions (forthcoming)"');
  });

  it("allows admin preview only when local dev preview is enabled", () => {
    const previousValue = process.env.RD_SYNC_DEV_PREVIEW;

    try {
      delete process.env.RD_SYNC_DEV_PREVIEW;
      expect(resolvePreviewPrincipal({ previewRole: "admin" })).toBeNull();

      process.env.RD_SYNC_DEV_PREVIEW = "enabled";
      expect(resolvePreviewPrincipal({ previewRole: "admin" })).toEqual({
        id: "admin-preview",
        role: "admin",
      });
      expect(resolvePreviewPrincipal({ previewRole: "viewer" })).toBeNull();
    } finally {
      if (previousValue === undefined) {
        delete process.env.RD_SYNC_DEV_PREVIEW;
      } else {
        process.env.RD_SYNC_DEV_PREVIEW = previousValue;
      }
    }
  });
});
