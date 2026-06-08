import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./card";

describe("Card", () => {
  it("renders its children inside a card container", () => {
    const html = renderToStaticMarkup(<Card>Body</Card>);

    expect(html).toContain("Body");
    expect(html).toContain("rounded-xl");
    expect(html).toContain("border");
    expect(html).toContain("bg-card");
  });

  it("accepts and merges a custom className", () => {
    const html = renderToStaticMarkup(<Card className="custom-class">x</Card>);

    expect(html).toContain("custom-class");
  });
});

describe("CardHeader", () => {
  it("renders children with header spacing classes", () => {
    const html = renderToStaticMarkup(<CardHeader>Header</CardHeader>);

    expect(html).toContain("Header");
    expect(html).toContain("flex");
    expect(html).toContain("flex-col");
  });
});

describe("CardTitle", () => {
  it("renders a heading element with the right text", () => {
    const html = renderToStaticMarkup(<CardTitle>Card title</CardTitle>);

    expect(html).toContain("Card title");
    expect(html).toContain("font-semibold");
  });
});

describe("CardDescription", () => {
  it("renders muted helper text", () => {
    const html = renderToStaticMarkup(<CardDescription>Helper</CardDescription>);

    expect(html).toContain("Helper");
    expect(html).toContain("text-muted-foreground");
  });
});

describe("CardContent", () => {
  it("renders content with padding", () => {
    const html = renderToStaticMarkup(<CardContent>Body</CardContent>);

    expect(html).toContain("Body");
    expect(html).toContain("px-5");
    expect(html).toContain("py-5");
  });
});

describe("CardFooter", () => {
  it("renders footer with top border", () => {
    const html = renderToStaticMarkup(<CardFooter>Footer</CardFooter>);

    expect(html).toContain("Footer");
    expect(html).toContain("border-t");
  });
});
