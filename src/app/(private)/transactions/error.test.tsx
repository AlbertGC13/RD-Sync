import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import TransactionsError from "./error";

describe("TransactionsError (route error boundary)", () => {
  it("renders the Spanish error copy and exposes a Reintentar reset affordance", () => {
    const html = renderToStaticMarkup(
      <TransactionsError
        error={new Error("upstream ingest failure")}
        reset={() => undefined}
      />,
    );

    // Visible copy is in Spanish — operators are Dominican banking staff.
    expect(html).toContain("Transacciones recientes");
    expect(html).toContain("No se pudieron cargar las transacciones");
    expect(html).toContain("Reintentar");

    // The raw error.message must NOT be exposed to the operator.
    expect(html).not.toContain("upstream ingest failure");
    expect(html).not.toContain("stack");
  });

  it("does NOT log raw error text from the source (operator-facing client boundary)", async () => {
    // Operator-facing boundaries must never call console.error(error) or
    // similar — that would surface internals (stack frames, upstream
    // messages) to the browser console. The raw error is already reported
    // server-side via Next.js's own reporting hooks, so the client stays
    // free of diagnostic leakage.
    const source = await readFile(
      new URL("./error.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/console\.error\(\s*error/);
    expect(source).not.toMatch(/console\.error\(\s*\[transactions\]/);
    // Defensive: useEffect is removed too — nothing should fire on mount
    // that touches the raw error object.
    expect(source).not.toMatch(/useEffect/);
  });
});
