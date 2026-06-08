import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Button } from "./button";

describe("Button", () => {
  it("renders its children inside a button element", () => {
    const html = renderToStaticMarkup(<Button>Apply filters</Button>);

    expect(html).toContain("<button");
    expect(html).toContain("Apply filters");
    expect(html).toContain("</button>");
  });

  it("applies the default primary variant classes", () => {
    const html = renderToStaticMarkup(<Button>Save</Button>);

    expect(html).toContain("bg-primary");
    expect(html).toContain("text-primary-foreground");
  });

  it("applies secondary variant classes when variant=secondary", () => {
    const html = renderToStaticMarkup(<Button variant="secondary">Cancel</Button>);

    expect(html).toContain("bg-secondary");
    expect(html).toContain("text-secondary-foreground");
  });

  it("applies outline variant classes when variant=outline", () => {
    const html = renderToStaticMarkup(<Button variant="outline">Back</Button>);

    expect(html).toContain("border");
    expect(html).toContain("bg-background");
  });

  it("applies destructive variant classes when variant=destructive", () => {
    const html = renderToStaticMarkup(<Button variant="destructive">Delete</Button>);

    expect(html).toContain("bg-destructive");
  });

  it("applies ghost variant classes when variant=ghost", () => {
    const html = renderToStaticMarkup(<Button variant="ghost">Dismiss</Button>);

    expect(html).toContain("hover:bg-muted");
  });

  it("renders the disabled attribute when disabled", () => {
    const html = renderToStaticMarkup(<Button disabled>Submit</Button>);

    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it("applies size=sm classes when size=sm", () => {
    const html = renderToStaticMarkup(<Button size="sm">Small</Button>);

    expect(html).toContain("h-9");
  });

  it("applies size=lg classes when size=lg", () => {
    const html = renderToStaticMarkup(<Button size="lg">Large</Button>);

    expect(html).toContain("h-11");
  });

  it("applies size=icon classes when size=icon", () => {
    const html = renderToStaticMarkup(<Button size="icon" aria-label="close">X</Button>);

    expect(html).toContain("h-10");
    expect(html).toContain("w-10");
  });

  it("forwards extra HTML attributes like type and aria-label", () => {
    const html = renderToStaticMarkup(
      <Button type="submit" aria-label="apply">
        Go
      </Button>,
    );

    expect(html).toContain('type="submit"');
    expect(html).toContain('aria-label="apply"');
  });
});
