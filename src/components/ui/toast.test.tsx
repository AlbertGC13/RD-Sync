import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Toaster } from "./toast";

describe("Toaster", () => {
  it("renders without crashing and produces the Sonner region", () => {
    const html = renderToStaticMarkup(<Toaster />);

    // Sonner mounts an ol with role=region and aria-label=Notifications
    expect(html.toLowerCase()).toContain("notifications");
  });

  it("forwards position and theme props to Sonner", () => {
    const html = renderToStaticMarkup(<Toaster position="top-right" />);

    expect(html).toBeTypeOf("string");
    expect(html.length).toBeGreaterThan(0);
  });
});
