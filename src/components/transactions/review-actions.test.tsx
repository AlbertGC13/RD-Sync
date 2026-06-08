import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReviewActions } from "./review-actions";

describe("ReviewActions", () => {
  it("renders all five review states as disabled buttons with forthcoming tooltip", () => {
    const html = renderToStaticMarkup(
      <ReviewActions transactionId="tx-1" currentState="new" />,
    );

    // All five states are visible per spec, but disabled.
    expect(html).toContain("new");
    expect(html).toContain("seen");
    expect(html).toContain("internally validated");
    expect(html).toContain("ignored");
    expect(html).toContain("needs review");
    // Each button is disabled to avoid fake-success interactivity.
    expect(html).toContain("disabled");
    expect(html).toContain('aria-disabled="true"');
    // Honest affordance: the group label names the deferral.
    expect(html).toContain("Review actions (forthcoming)");
  });
});
