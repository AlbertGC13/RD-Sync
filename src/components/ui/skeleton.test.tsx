import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Skeleton } from "./skeleton";

describe("Skeleton", () => {
  it("renders a div with the animate-pulse class", () => {
    const html = renderToStaticMarkup(<Skeleton />);

    expect(html).toContain("<div");
    expect(html).toContain("animate-pulse");
    expect(html).toContain("bg-muted");
  });

  it("accepts a custom className to override dimensions", () => {
    const html = renderToStaticMarkup(<Skeleton className="h-12 w-48" />);

    expect(html).toContain("h-12");
    expect(html).toContain("w-48");
  });
});
