import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import HomePage from "./page";

describe("HomePage", () => {
  it("shows clear preview navigation for employee and admin flows in Spanish", () => {
    const html = renderToStaticMarkup(<HomePage />);

    expect(html).toContain("Flujo de empleado");
    expect(html).toContain('href="/transactions"');
    expect(html).toContain("Flujo de administrador");
    expect(html).toContain('href="/admin/scrape-runs"');
    // Operator-facing copy is Spanish (Dominican banking staff).
    expect(html).toContain("Abrir transacciones");
    expect(html).toContain("Abrir operaciones admin");
    // previewRole backdoor must NOT be present
    expect(html).not.toContain("previewRole");
  });
});
