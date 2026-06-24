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
    info: vi.fn(),
  },
}));

import { RefreshButton, refreshTransactions } from "./refresh-button";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Helpers — keep response construction DRY and explicit.
// ---------------------------------------------------------------------------

function post202Response(runId: string, bankId = "popular"): Response {
  return new Response(
    JSON.stringify({
      run: {
        runId,
        bankId,
        accountFingerprint: "popular-test",
        status: "queued",
      },
    }),
    { status: 202, headers: { "Content-Type": "application/json" } },
  );
}

function statusResponse(status: string, runId = "r"): Response {
  return new Response(
    JSON.stringify({
      run: {
        id: runId,
        bankId: "popular",
        status,
        insertedCount: 0,
        skippedCount: 0,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** Instant sleep so terminal-poll tests run without real delays. */
const instantSleep = (): Promise<void> => Promise.resolve();

function resetToasts() {
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(toast.info).mockReset();
}

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

describe("refreshTransactions — 202 polling contract", () => {
  beforeEach(resetToasts);
  afterEach(resetToasts);

  it("on 202 polls until succeeded, then fires the success toast + onRefresh (router.refresh) — not on the 202 itself", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    // Default for any poll beyond the explicit sequence: succeed.
    fetchImpl.mockResolvedValue(statusResponse("succeeded"));
    // Call 1: the POST 202 carrying the internal run id.
    fetchImpl.mockResolvedValueOnce(post202Response("run-internal-1"));

    const onRefresh = vi.fn();

    await refreshTransactions({ fetchImpl, onRefresh, sleep: instantSleep });

    // The POST was made exactly once to run-now.
    const postCall = fetchImpl.mock.calls[0]!;
    expect(postCall[0]).toBe("/api/scrape-runs/run-now");
    expect(postCall[1]?.method).toBe("POST");
    expect(postCall[1]?.headers).toEqual({ "Content-Type": "application/json" });

    // At least one poll (GET) followed the POST.
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
    const pollCall = fetchImpl.mock.calls[1]!;
    expect(pollCall[0]).toBe("/api/scrape-runs/run-internal-1");
    expect(pollCall[1]?.method).toBe("GET");

    // Informational toast fires once (queued), success toast fires once (terminal).
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith("Corrida solicitada. Verificando resultado…");
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("Transacciones actualizadas.");
    // onRefresh fires exactly once — AFTER the terminal poll, never on the 202.
    expect(onRefresh).toHaveBeenCalledTimes(1);
    // The success toast must not leak the internal run id.
    const message = vi.mocked(toast.success).mock.calls[0]?.[0] as string;
    expect(message).not.toContain("run-internal-1");
  });

  it("polls queued → running → succeeded and refreshes only after succeeded", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(statusResponse("succeeded")); // fallback default
    fetchImpl.mockResolvedValueOnce(post202Response("run-seq"));
    fetchImpl.mockResolvedValueOnce(statusResponse("queued", "run-seq"));
    fetchImpl.mockResolvedValueOnce(statusResponse("running", "run-seq"));

    const onRefresh = vi.fn();

    await refreshTransactions({ fetchImpl, onRefresh, sleep: instantSleep });

    // call 0 = POST, call 1 = poll (queued), call 2 = poll (running),
    // call 3 = poll (succeeded via default) → terminal.
    expect(fetchImpl.mock.calls.length).toBe(4);
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("Transacciones actualizadas.");
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("on needs_admin_action shows the admin-action toast and refreshes", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(statusResponse("needs_admin_action"));
    fetchImpl.mockResolvedValueOnce(post202Response("run-mfa"));

    const onRefresh = vi.fn();

    await refreshTransactions({ fetchImpl, onRefresh, sleep: instantSleep });

    expect(toast.error).toHaveBeenCalledWith(
      "La sesión del banco requiere acción del administrador.",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("on failed shows the failure toast and refreshes", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(statusResponse("failed"));
    fetchImpl.mockResolvedValueOnce(post202Response("run-fail"));

    const onRefresh = vi.fn();

    await refreshTransactions({ fetchImpl, onRefresh, sleep: instantSleep });

    expect(toast.error).toHaveBeenCalledWith(
      "No se pudo completar la actualización. Intente nuevamente.",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("on polling timeout shows the still-processing toast and refreshes once", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    // Every poll returns non-terminal `queued` so the loop runs until deadline.
    fetchImpl.mockResolvedValue(statusResponse("queued"));
    fetchImpl.mockResolvedValueOnce(post202Response("run-slow"));

    const onRefresh = vi.fn();

    await refreshTransactions({
      fetchImpl,
      onRefresh,
      pollIntervalMs: 5,
      pollTimeoutMs: 20,
      // real (default) sleep so the deadline advances in wall-clock time.
    });

    expect(toast.error).toHaveBeenCalledWith(
      "La corrida sigue procesándose. Actualice nuevamente en unos momentos.",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledTimes(1);
    // Refresh fires exactly once on timeout.
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("on a 404 mid-poll shows the unverified toast (NOT 'still processing') and refreshes once", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(post202Response("run-gone"));
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Scrape run not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const onRefresh = vi.fn();

    await refreshTransactions({ fetchImpl, onRefresh, sleep: instantSleep });

    expect(toast.error).toHaveBeenCalledWith(
      "No se pudo verificar el resultado de la corrida. Actualice nuevamente en unos momentos.",
    );
    // A missing run must NOT be reported as "still processing".
    expect(toast.error).not.toHaveBeenCalledWith(
      "La corrida sigue procesándose. Actualice nuevamente en unos momentos.",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("on a hung status GET (never resolves) aborts via the deadline, re-enables the button, and refreshes once", async () => {
    // The POST succeeds (202) so we enter polling; every poll GET then hangs
    // and only rejects once its AbortController fires — mirroring a real hung
    // backend. The per-poll deadline abort must fire so the button is never
    // disabled forever.
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(post202Response("run-hang"));
    fetchImpl.mockImplementation((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    });

    const onRefresh = vi.fn();

    await refreshTransactions({
      fetchImpl,
      onRefresh,
      pollIntervalMs: 5,
      pollTimeoutMs: 60,
      // real (default) sleep so the deadline/abort timers advance in wall-clock.
    });

    // The hung GET must produce the safe still-processing toast (timeout
    // outcome) — never leaving the button disabled.
    expect(toast.error).toHaveBeenCalledWith(
      "La corrida sigue procesándose. Actualice nuevamente en unos momentos.",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // At least one poll GET was attempted and carried an AbortSignal so the
    // hung fetch could be cancelled by the deadline.
    const pollCall = fetchImpl.mock.calls[1];
    expect(pollCall?.[0]).toBe("/api/scrape-runs/run-hang");
    expect(pollCall?.[1]?.method).toBe("GET");
    expect(pollCall?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("on a hung response body (headers arrive but json() never resolves) the deadline abort still breaks out and refreshes once", async () => {
    // Models a fetch implementation that returns headers (200 OK) but whose
    // body stream stalls forever AND does not reject on abort — i.e. the
    // signal passed to fetch does NOT propagate to the body read. Without the
    // deadline covering the body parse, response.json() would hang forever and
    // the button would stay disabled. The poll must surface a safe timeout.
    const hangingBodyResponse = (): Response =>
      ({
        status: 200,
        ok: true,
        headers: new Headers({ "Content-Type": "application/json" }),
        // json() neither resolves nor rejects, even on abort.
        json: () => new Promise<unknown>(() => {}),
      }) as unknown as Response;

    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(post202Response("run-body-hang"));
    fetchImpl.mockResolvedValue(hangingBodyResponse());

    const onRefresh = vi.fn();

    await refreshTransactions({
      fetchImpl,
      onRefresh,
      pollIntervalMs: 5,
      pollTimeoutMs: 60,
      // real (default) sleep so the deadline/abort timers advance in wall-clock.
    });

    expect(toast.error).toHaveBeenCalledWith(
      "La corrida sigue procesándose. Actualice nuevamente en unos momentos.",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // The poll GET carried an AbortSignal so the deadline could abort it.
    const pollCall = fetchImpl.mock.calls[1];
    expect(pollCall?.[0]).toBe("/api/scrape-runs/run-body-hang");
    expect(pollCall?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends NO body when bankId is omitted so the backend defaults to Popular", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(statusResponse("succeeded"));
    fetchImpl.mockResolvedValueOnce(post202Response("r"));

    await refreshTransactions({
      fetchImpl,
      onRefresh: () => undefined,
      sleep: instantSleep,
    });

    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.body).toBeUndefined();
  });

  it("sends a { bankId } body when a bankId is provided", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(statusResponse("succeeded"));
    fetchImpl.mockResolvedValueOnce(post202Response("r"));

    await refreshTransactions({
      bankId: "popular",
      fetchImpl,
      onRefresh: () => undefined,
      sleep: instantSleep,
    });

    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.body).toBe(JSON.stringify({ bankId: "popular" }));
  });

  it("never leaks the run id, account fingerprint, or internal text into any toast", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValue(statusResponse("succeeded"));
    fetchImpl.mockResolvedValueOnce(post202Response("run-secret-xyz-123"));

    await refreshTransactions({
      fetchImpl,
      onRefresh: () => undefined,
      sleep: instantSleep,
    });

    const allMessages = [
      ...vi.mocked(toast.info).mock.calls.map((c) => String(c[0])),
      ...vi.mocked(toast.success).mock.calls.map((c) => String(c[0])),
      ...vi.mocked(toast.error).mock.calls.map((c) => String(c[0])),
    ];

    for (const message of allMessages) {
      expect(message).not.toContain("run-secret-xyz-123");
      expect(message).not.toContain("run-secret");
      expect(message).not.toContain("xyz-123");
      expect(message).not.toContain("accountFingerprint");
      expect(message).not.toContain("popular-test");
    }
  });
});

describe("refreshTransactions — failure paths (no leaked error.message, no onRefresh)", () => {
  beforeEach(resetToasts);
  afterEach(resetToasts);

  it("on 409 shows the conflict toast and does NOT call onRefresh", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "An active scrape run already exists for this bank" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );
    const onRefresh = vi.fn();

    await refreshTransactions({ fetchImpl, onRefresh });

    expect(toast.error).toHaveBeenCalledWith(
      "Ya hay una corrida en proceso. Espere a que termine.",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("on 400 shows the unsupported-bank toast and does NOT call onRefresh", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "Bank not currently supported for manual runs" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );
    const onRefresh = vi.fn();

    await refreshTransactions({ bankId: "banreservas", fetchImpl, onRefresh });

    expect(toast.error).toHaveBeenCalledWith(
      "Banco no soportado para corridas manuales.",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("on 401 shows the permission toast and does NOT call onRefresh", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "Unable to schedule run" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    );
    const onRefresh = vi.fn();

    await refreshTransactions({ fetchImpl, onRefresh });

    expect(toast.error).toHaveBeenCalledWith(
      "No tiene permisos para realizar esta acción.",
    );
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("on 403 shows the permission toast and does NOT call onRefresh", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "Unable to schedule run" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );
    const onRefresh = vi.fn();

    await refreshTransactions({ fetchImpl, onRefresh });

    expect(toast.error).toHaveBeenCalledWith(
      "No tiene permisos para realizar esta acción.",
    );
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("on 503 shows the connection toast and does NOT call onRefresh", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "Unable to schedule run" }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      ),
    );
    const onRefresh = vi.fn();

    await refreshTransactions({ fetchImpl, onRefresh });

    expect(toast.error).toHaveBeenCalledWith(
      "No se pudo conectar con el servidor. Intente nuevamente.",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("on a thrown network error shows the connection toast and does NOT call onRefresh", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );
    const onRefresh = vi.fn();

    await refreshTransactions({ fetchImpl, onRefresh });

    expect(toast.error).toHaveBeenCalledWith(
      "No se pudo conectar con el servidor. Intente nuevamente.",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("aborts and shows the connection toast when the server hangs (initial POST timeout fires)", async () => {
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
    const onRefresh = vi.fn();

    await refreshTransactions({ fetchImpl, onRefresh, timeoutMs: 50 });

    expect(toast.error).toHaveBeenCalledWith(
      "No se pudo conectar con el servidor. Intente nuevamente.",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("never leaks raw backend error text into any toast on an unexpected 500", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "Postgres ECONNREFUSED 127.0.0.1:5432 stack:..." }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ),
    );

    await refreshTransactions({ fetchImpl, onRefresh: () => undefined });

    expect(toast.error).toHaveBeenCalledTimes(1);
    const message = vi.mocked(toast.error).mock.calls[0]?.[0] as string;
    expect(message).not.toContain("Postgres");
    expect(message).not.toContain("ECONNREFUSED");
    expect(message).not.toContain("stack");
    expect(message).not.toContain("127.0.0.1");
  });
});
