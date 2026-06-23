import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReviewActions } from "./review-actions";

describe("ReviewActions", () => {
  it("renders all five review states as disabled buttons with Spanish labels and the forthcoming group label", () => {
    const html = renderToStaticMarkup(
      <ReviewActions transactionId="tx-1" currentState="new" />,
    );

    // All five states are visible per spec, in Spanish.
    expect(html).toContain("Nueva");
    expect(html).toContain("Vista");
    expect(html).toContain("Validada internamente");
    expect(html).toContain("Ignorada");
    expect(html).toContain("Pendiente de revisión");
    // No raw enum identifier must leak as a visible label.
    expect(html).not.toContain("internally validated");
    expect(html).not.toContain("needs review");
    expect(html).not.toContain("ignored\">");
    // Each button is disabled to avoid fake-success interactivity.
    expect(html).toContain("disabled");
    expect(html).toContain('aria-disabled="true"');
    // Honest affordance: the group label names the deferral in Spanish.
    // (The Radix tooltip body lives in a Portal and is not in the static
    // markup; the localized string is covered by the a11y-smoke source test.)
    expect(html).toContain("Acciones de revisión (próximamente)");
  });

  it("tags the current review state with data-current so styling can highlight it", () => {
    const html = renderToStaticMarkup(
      <ReviewActions transactionId="tx-1" currentState="needs_review" />,
    );
    expect(html).toMatch(/data-state="needs_review"[^>]*data-current="true"/);
  });
});
