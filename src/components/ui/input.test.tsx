import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Input } from "./input";

describe("Input", () => {
  it("renders an input element", () => {
    const html = renderToStaticMarkup(<Input placeholder="Search" />);

    expect(html).toContain("<input");
    expect(html).toContain('placeholder="Search"');
  });

  it("applies the default input class names", () => {
    const html = renderToStaticMarkup(<Input />);

    expect(html).toContain("rounded-md");
    expect(html).toContain("border");
    expect(html).toContain("border-input");
    expect(html).toContain("bg-background");
  });

  it("forwards the type attribute", () => {
    const html = renderToStaticMarkup(<Input type="email" />);

    expect(html).toContain('type="email"');
  });

  it("renders the disabled attribute when disabled", () => {
    const html = renderToStaticMarkup(<Input disabled />);

    expect(html).toMatch(/<input[^>]*disabled/);
  });

  it("merges a custom className", () => {
    const html = renderToStaticMarkup(<Input className="w-32" />);

    expect(html).toContain("w-32");
  });
});
