import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buildRunNowEndpoint, RunActionAffordances } from "./run-action-affordances";

describe("RunActionAffordances", () => {
  it("enables retry scheduling while keeping disable and renew as honest stubs", () => {
    const html = renderToStaticMarkup(
      <RunActionAffordances runId="run-1" status="needs_admin_action" />,
    );
    const retryButton = html.match(/<button[^>]*data-action="retry"[^>]*>Retry run<\/button>/)?.[0];
    const disableButton = html.match(/<button[^>]*data-action="disable"[^>]*>Disable connection<\/button>/)?.[0];
    const renewButton = html.match(/<button[^>]*data-action="renew"[^>]*>Renew session<\/button>/)?.[0];

    expect(html).toContain("Retry run");
    expect(html).toContain("Disable connection");
    expect(html).toContain("Renew session");
    expect(retryButton).toBeDefined();
    expect(retryButton).not.toContain('disabled=""');
    expect(retryButton).not.toContain('aria-disabled="true"');
    expect(retryButton).toContain('aria-label="Schedule a new ingestion run now"');
    // Honest stubs: deferred actions remain disabled and labelled.
    expect(disableButton).toContain('disabled=""');
    expect(disableButton).toContain('aria-disabled="true"');
    expect(renewButton).toContain('disabled=""');
    expect(renewButton).toContain('aria-disabled="true"');
    expect(html).toContain("Run actions");
    expect(html).toContain("Current status: needs admin action");
  });

  it("preserves local preview role when building the run-now endpoint", () => {
    expect(buildRunNowEndpoint("?previewRole=admin")).toBe(
      "/api/scrape-runs/run-now?previewRole=admin",
    );
    expect(buildRunNowEndpoint("?bankId=popular")).toBe("/api/scrape-runs/run-now");
  });
});
