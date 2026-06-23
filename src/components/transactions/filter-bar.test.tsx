import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { useRouter } from "next/navigation";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams("bankId=popular&query=factura"),
  usePathname: () => "/transactions",
}));

import { FilterBar, buildFilterRemovalUrl, removeFilterAndNavigate } from "./filter-bar";

describe("buildFilterRemovalUrl — chip removal navigation target (T7 behavior)", () => {
  it("removes the given key and keeps the remaining filters", () => {
    expect(
      buildFilterRemovalUrl(new URLSearchParams("bankId=popular&query=factura"), "bankId"),
    ).toBe("/transactions?query=factura");
  });

  it("navigates to the bare transactions path when the removed key was the only filter", () => {
    expect(buildFilterRemovalUrl(new URLSearchParams("bankId=popular"), "bankId")).toBe(
      "/transactions",
    );
  });

  it("preserves multiple remaining keys in order", () => {
    expect(
      buildFilterRemovalUrl(
        new URLSearchParams("bankId=popular&currency=DOP&query=abc"),
        "currency",
      ),
    ).toBe("/transactions?bankId=popular&query=abc");
  });

  it("is a no-op navigation when the key is absent from the committed params", () => {
    expect(
      buildFilterRemovalUrl(new URLSearchParams("bankId=popular"), "query"),
    ).toBe("/transactions?bankId=popular");
  });
});

describe("removeFilterAndNavigate — chip removal calls router.push (T7 behavior)", () => {
  it("pushes the URL returned by buildFilterRemovalUrl for the removed key", () => {
    const push = vi.fn();
    const router = { push } as unknown as ReturnType<typeof useRouter>;
    const params = new URLSearchParams("bankId=popular&query=factura");

    removeFilterAndNavigate(params, "bankId", router);

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(buildFilterRemovalUrl(params, "bankId"));
  });

  it("navigates to the bare transactions path when removing the only filter", () => {
    const push = vi.fn();
    const router = { push } as unknown as ReturnType<typeof useRouter>;
    const params = new URLSearchParams("bankId=popular");

    removeFilterAndNavigate(params, "bankId", router);

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/transactions");
  });

  it("preserves the remaining keys in the pushed URL", () => {
    const push = vi.fn();
    const router = { push } as unknown as ReturnType<typeof useRouter>;
    const params = new URLSearchParams("bankId=popular&currency=DOP&query=abc");

    removeFilterAndNavigate(params, "currency", router);

    expect(push).toHaveBeenCalledWith("/transactions?bankId=popular&query=abc");
  });
});

describe("FilterBar — active filter chips (T7)", () => {
  it("gives every removable chip an aria-label that announces what removing it does", () => {
    const html = renderToStaticMarkup(
      <FilterBar
        filters={{ bankId: "popular", query: "factura" }}
        activeCount={2}
        resultCount={5}
      />,
    );

    // Each chip announces "Quitar filtro: {name}: {value}" so screen readers
    // convey what the remove action does.
    expect(html).toContain('aria-label="Quitar filtro: Banco: popular"');
    expect(html).toContain('aria-label="Quitar filtro: Búsqueda: factura"');
  });

  it("renders the chip remove buttons as type=button so they never submit the form", () => {
    const html = renderToStaticMarkup(
      <FilterBar filters={{ bankId: "popular" }} activeCount={1} resultCount={3} />,
    );

    const chipButton = html.match(/<button[^>]*aria-label="Quitar filtro: Banco: popular"[^>]*>/)?.[0];
    expect(chipButton).toBeDefined();
    expect(chipButton).toContain('type="button"');
  });
});

describe("FilterBar — amount filter semantics (T8)", () => {
  it("adds a format placeholder and a DOP helper text wired via aria-describedby", () => {
    const html = renderToStaticMarkup(
      <FilterBar filters={{}} activeCount={0} resultCount={0} />,
    );

    expect(html).toContain('placeholder="Ej: 1500.50"');
    expect(html).toContain("Monto exacto en DOP");
    expect(html).toContain('aria-describedby="filter-amount-hint"');
    // The helper text element carries the id the input points at.
    expect(html).toContain('id="filter-amount-hint"');
  });
});
