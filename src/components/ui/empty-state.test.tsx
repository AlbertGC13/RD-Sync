import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EmptyState } from "./empty-state";

describe("EmptyState", () => {
  it("renders its title and description", () => {
    const html = renderToStaticMarkup(
      <EmptyState title="No transactions" description="Ingestion has not stored any movements yet." />,
    );

    expect(html).toContain("No transactions");
    expect(html).toContain("Ingestion has not stored any movements yet.");
  });

  it("uses a card-like container", () => {
    const html = renderToStaticMarkup(
      <EmptyState title="t" description="d" />,
    );

    expect(html).toContain("rounded-lg");
    expect(html).toContain("border");
  });

  it("renders the action node when provided", () => {
    const html = renderToStaticMarkup(
      <EmptyState
        title="t"
        description="d"
        action={<button type="button">Retry</button>}
      />,
    );

    expect(html).toContain("<button");
    expect(html).toContain("Retry");
  });
});
