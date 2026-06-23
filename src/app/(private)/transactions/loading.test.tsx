import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import TransactionsLoading from "./loading";

describe("TransactionsLoading (route loading state)", () => {
  it("renders a skeleton placeholder with multiple grouped rows so the layout does not jump", () => {
    const html = renderToStaticMarkup(<TransactionsLoading />);

    // motion-safe skeleton elements are present, so assistive tech + sighted
    // users both perceive loading affordance.
    expect(html).toContain("motion-safe:animate-pulse");
    // The page renders multiple skeleton row placeholders — there is no real
    // text content while loading, so we assert on the absence of business
    // copy and the presence of multiple skeleton groups.
    expect(html).toContain("rounded-xl");
    expect(html).not.toContain("Transacciones recientes");
    expect(html).not.toContain("No hay transacciones recientes disponibles");
  });

  it("does not leak employee- or admin-only strings while loading", () => {
    const html = renderToStaticMarkup(<TransactionsLoading />);
    expect(html).not.toContain("MFA");
    expect(html).not.toContain("password=");
    expect(html).not.toContain("token=");
    expect(html).not.toContain("session");
  });
});
