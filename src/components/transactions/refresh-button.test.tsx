import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { RefreshButton, refreshTransactions } from "./refresh-button";
import { toast } from "sonner";

describe("RefreshButton — static render", () => {
  it("renders a button labelled 'Refrescar' with the accessible name 'Refrescar transacciones'", () => {
    const html = renderToStaticMarkup(<RefreshButton />);

    expect(html).toContain("Refrescar");
    expect(html).toContain('aria-label="Refrescar transacciones"');
    expect(html).toMatch(/<button[^>]*>/);
  });

  it("is interactive by default (not disabled) so any authenticated user can trigger a refresh", () => {
    const html = renderToStaticMarkup(<RefreshButton />);

    // pending starts false → the disabled attribute is omitted from the
    // button element. The cva base classes intentionally contain
    // "disabled:pointer-events-none" / "disabled:opacity-50" CSS tokens, so
    // we assert on the opening <button> tag rather than the whole string:
    // React serializes a true boolean as `disabled=""`, which never appears
    // in the class list.
    const buttonTag = html.match(/<button[^>]*>/)?.[0] ?? "";
    expect(buttonTag).toMatch(/^<button/);
    expect(buttonTag).not.toContain('disabled=""');
  });

  it("does not expose internal ids, run details, or endpoint paths in the static markup", () => {
    const html = renderToStaticMarkup(<RefreshButton />);

    expect(html).not.toContain("runId");
    expect(html).not.toContain("run-now");
  });
});

describe("refreshTransactions — request contract", () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  afterEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("POSTs to /api/scrape-runs/run-now and on 202 fires a success toast + onSuccess (router.refresh)", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          run: {
            runId: "run-internal-1",
            bankId: "popular",
            accountFingerprint: "popular-0000000000",
            status: "queued",
          },
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      ),
    );
    const onSuccess = vi.fn();

    await refreshTransactions({ fetchImpl, onSuccess });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/scrape-runs/run-now");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    // The success toast must not leak the internal run id.
    const message = vi.mocked(toast.success).mock.calls[0]?.[0] as string;
    expect(message).not.toContain("run-internal-1");
  });

  it("sends NO body when bankId is omitted so the backend defaults to Popular", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ run: { runId: "r", bankId: "popular", accountFingerprint: "a", status: "queued" } }),
        { status: 202 },
      ),
    );

    await refreshTransactions({ fetchImpl, onSuccess: () => undefined });

    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.body).toBeUndefined();
  });

  it("sends a { bankId } body when a bankId is provided", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ run: { runId: "r", bankId: "popular", accountFingerprint: "a", status: "queued" } }),
        { status: 202 },
      ),
    );

    await refreshTransactions({ bankId: "popular", fetchImpl, onSuccess: () => undefined });

    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.body).toBe(JSON.stringify({ bankId: "popular" }));
  });
});

describe("refreshTransactions — failure paths (no leaked error.message, no onSuccess)", () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  afterEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("on 409 shows the conflict toast and does NOT call onSuccess", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "An active scrape run already exists for this bank" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );
    const onSuccess = vi.fn();

    await refreshTransactions({ fetchImpl, onSuccess });

    expect(toast.error).toHaveBeenCalledWith(
      "Ya hay una corrida en proceso. Espere a que termine.",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("on 400 shows the unsupported-bank toast and does NOT call onSuccess", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "Bank not currently supported for manual runs" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );
    const onSuccess = vi.fn();

    await refreshTransactions({ bankId: "banreservas", fetchImpl, onSuccess });

    expect(toast.error).toHaveBeenCalledWith(
      "Banco no soportado para corridas manuales.",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("on 401 shows the permission toast and does NOT call onSuccess", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "Unable to schedule run" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    );
    const onSuccess = vi.fn();

    await refreshTransactions({ fetchImpl, onSuccess });

    expect(toast.error).toHaveBeenCalledWith(
      "No tiene permisos para realizar esta acción.",
    );
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("on 403 shows the permission toast and does NOT call onSuccess", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "Unable to schedule run" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );
    const onSuccess = vi.fn();

    await refreshTransactions({ fetchImpl, onSuccess });

    expect(toast.error).toHaveBeenCalledWith(
      "No tiene permisos para realizar esta acción.",
    );
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("on 503 shows the connection toast and does NOT call onSuccess", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "Unable to schedule run" }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      ),
    );
    const onSuccess = vi.fn();

    await refreshTransactions({ fetchImpl, onSuccess });

    expect(toast.error).toHaveBeenCalledWith(
      "No se pudo conectar con el servidor. Intente nuevamente.",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("on a thrown network error shows the connection toast and does NOT call onSuccess", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );
    const onSuccess = vi.fn();

    await refreshTransactions({ fetchImpl, onSuccess });

    expect(toast.error).toHaveBeenCalledWith(
      "No se pudo conectar con el servidor. Intente nuevamente.",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("aborts and shows the connection toast when the server hangs (timeout fires)", async () => {
    // A fetch that never resolves on its own — it only rejects once the
    // AbortSignal fires. This mirrors how a real hung backend behaves: the
    // request stays pending until the AbortController aborts it.
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    });
    const onSuccess = vi.fn();

    await refreshTransactions({ fetchImpl, onSuccess, timeoutMs: 50 });

    expect(toast.error).toHaveBeenCalledWith(
      "No se pudo conectar con el servidor. Intente nuevamente.",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("never leaks raw backend error text into any toast on an unexpected 500", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "Postgres ECONNREFUSED 127.0.0.1:5432 stack:..." }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ),
    );

    await refreshTransactions({ fetchImpl, onSuccess: () => undefined });

    expect(toast.error).toHaveBeenCalledTimes(1);
    const message = vi.mocked(toast.error).mock.calls[0]?.[0] as string;
    expect(message).not.toContain("Postgres");
    expect(message).not.toContain("ECONNREFUSED");
    expect(message).not.toContain("stack");
    expect(message).not.toContain("127.0.0.1");
  });
});
