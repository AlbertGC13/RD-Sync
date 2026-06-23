import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import RootLayout from "./layout";

describe("RootLayout", () => {
  it("renders the sonner toaster so feature stubs can surface 'not implemented' toasts", () => {
    const html = renderToStaticMarkup(
      <RootLayout>
        <main>page content</main>
      </RootLayout>,
    );

    // sonner's Toaster renders a `<section>` with `aria-label` starting with
    // "Notifications" (the default `containerAriaLabel`) as its mount point.
    // We assert on the prefix rather than the full string because sonner
    // appends the hotkey label (e.g. "Notifications alt+T") and we don't
    // want the test to be brittle to hotkey changes.
    expect(html).toMatch(/aria-label="Notifications[^"]*"/);
  });

  it("renders an admin nav placeholder with Spanish Transactions and Admin links", () => {
    const html = renderToStaticMarkup(
      <RootLayout>
        <main>page content</main>
      </RootLayout>,
    );

    expect(html).toContain('href="/transactions"');
    expect(html).toContain("Transacciones");
    expect(html).toContain('href="/admin/scrape-runs"');
    expect(html).toContain("Administración");
    expect(html).toContain('href="/admin/bank-connections"');
    expect(html).toContain("Conexiones");
    // Operator-facing footer copy is Spanish.
    expect(html).toContain("Visibilidad bancaria de solo lectura");
    expect(html).toContain("Última sincronización: en vivo");
  });
});
