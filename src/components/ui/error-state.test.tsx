import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ErrorState } from "./error-state";

describe("ErrorState", () => {
  it("renders the title and description", () => {
    const html = renderToStaticMarkup(
      <ErrorState title="Failed to load" description="We could not reach the API." />,
    );

    expect(html).toContain("Failed to load");
    expect(html).toContain("We could not reach the API.");
  });

  it("renders a retry action when provided", () => {
    const html = renderToStaticMarkup(
      <ErrorState
        title="t"
        description="d"
        retry={<button type="button">Try again</button>}
      />,
    );

    expect(html).toContain("Try again");
  });

  it("never renders raw stack traces in the description prop", () => {
    const html = renderToStaticMarkup(
      <ErrorState
        title="Failed"
        description="Something went wrong while loading the page."
      />,
    );

    expect(html).not.toContain("at Object.");
    expect(html).not.toContain("node_modules");
  });
});
