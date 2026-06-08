import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RunActionAffordances } from "./run-action-affordances";

describe("RunActionAffordances", () => {
  it("renders the three FR-012 action affordances as disabled with forthcoming tooltips", () => {
    const html = renderToStaticMarkup(
      <RunActionAffordances runId="run-1" status="needs_admin_action" />,
    );

    expect(html).toContain("Retry run");
    expect(html).toContain("Disable connection");
    expect(html).toContain("Renew session");
    // Honest stubs: every action is disabled and labelled.
    expect(html).toContain("disabled");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Run actions (forthcoming)");
    expect(html).toContain("Current status: needs admin action");
  });
});
