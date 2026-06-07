import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import HomePage from "./page";

describe("HomePage", () => {
  it("shows clear preview navigation for employee and admin flows", () => {
    const html = renderToStaticMarkup(<HomePage />);

    expect(html).toContain("Transaction dashboard MVP");
    expect(html).toContain("Employee flow");
    expect(html).toContain("href=\"/transactions\"");
    expect(html).toContain("Admin demo flow");
    expect(html).toContain("href=\"/admin/scrape-runs?previewRole=admin\"");
  });
});
