import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PageHeader } from "./page-header";

describe("PageHeader", () => {
  it("renders the eyebrow, title, and description", () => {
    const html = renderToStaticMarkup(
      <PageHeader
        eyebrow="RD-Sync"
        title="Recent transactions"
        description="Employee-safe visibility into normalized bank movements."
      />,
    );

    expect(html).toContain("RD-Sync");
    expect(html).toContain("Recent transactions");
    expect(html).toContain("Employee-safe visibility into normalized bank movements.");
  });

  it("uses an h1 for the title", () => {
    const html = renderToStaticMarkup(
      <PageHeader eyebrow="x" title="My title" description="d" />,
    );

    expect(html).toMatch(/<h1[^>]*>My title<\/h1>/);
  });

  it("renders an actions slot when provided", () => {
    const html = renderToStaticMarkup(
      <PageHeader
        eyebrow="x"
        title="t"
        description="d"
        actions={<button type="button">Action</button>}
      />,
    );

    expect(html).toContain("Action");
  });
});
