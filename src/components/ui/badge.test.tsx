import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Badge } from "./badge";

describe("Badge", () => {
  it("renders its children inside a span", () => {
    const html = renderToStaticMarkup(<Badge>Active</Badge>);

    expect(html).toContain("Active");
    expect(html).toContain("<span");
  });

  it("applies default variant classes", () => {
    const html = renderToStaticMarkup(<Badge>Default</Badge>);

    expect(html).toContain("bg-primary");
    expect(html).toContain("text-primary-foreground");
  });

  it("applies secondary variant classes when variant=secondary", () => {
    const html = renderToStaticMarkup(<Badge variant="secondary">S</Badge>);

    expect(html).toContain("bg-secondary");
  });

  it("applies destructive variant classes when variant=destructive", () => {
    const html = renderToStaticMarkup(<Badge variant="destructive">D</Badge>);

    expect(html).toContain("bg-destructive");
  });

  it("applies outline variant classes when variant=outline", () => {
    const html = renderToStaticMarkup(<Badge variant="outline">O</Badge>);

    expect(html).toContain("border");
    expect(html).toContain("text-foreground");
  });

  it("applies success variant classes when variant=success", () => {
    const html = renderToStaticMarkup(<Badge variant="success">OK</Badge>);

    expect(html).toContain("bg-success");
  });

  it("applies warning variant classes when variant=warning", () => {
    const html = renderToStaticMarkup(<Badge variant="warning">Warn</Badge>);

    expect(html).toContain("bg-warning");
  });

  it("merges a custom className", () => {
    const html = renderToStaticMarkup(<Badge className="ml-2">x</Badge>);

    expect(html).toContain("ml-2");
  });
});
