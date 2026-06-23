import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  RunActionAffordances,
  bankDisplayName,
  createRunNowClickHandler,
  scrapeRunStatusLabel,
  triggerRunNowForBank,
} from "./run-action-affordances";
import { toast } from "sonner";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

describe("RunActionAffordances", () => {
  it("enables run-now scheduling for a supported bank while keeping disable and renew as honest stubs", () => {
    const html = renderToStaticMarkup(
      <RunActionAffordances runId="run-1" bankId="popular" status="needs_admin_action" />,
    );
    const runNowButton = html.match(/<button[^>]*data-action="run-now"[^>]*>Ejecutar ahora<\/button>/)?.[0];
    const disableButton = html.match(/<button[^>]*data-action="disable"[^>]*>Desactivar conexión<\/button>/)?.[0];
    const renewButton = html.match(/<button[^>]*data-action="renew"[^>]*>Renovar sesión<\/button>/)?.[0];

    expect(html).toContain("Ejecutar ahora");
    expect(html).toContain("Desactivar conexión");
    expect(html).toContain("Renovar sesión");
    expect(runNowButton).toBeDefined();
    expect(runNowButton).not.toContain('disabled=""');
    expect(runNowButton).not.toContain('aria-disabled="true"');
    expect(runNowButton).toContain('aria-label="Programar una nueva corrida de extracción ahora"');
    // Honest stubs: deferred actions remain disabled and labelled.
    expect(disableButton).toContain('disabled=""');
    expect(disableButton).toContain('aria-disabled="true"');
    expect(renewButton).toContain('disabled=""');
    expect(renewButton).toContain('aria-disabled="true"');
    expect(html).toContain("Acciones de corrida");
    // Status text uses the localized label, NOT the raw underscore string.
    expect(html).toContain("Estado actual: Necesita acción administrativa");
    expect(html).not.toContain("needs admin action");
  });

  it("disables run-now and announces the unsupported-bank state via aria-label for non-supported banks", () => {
    const html = renderToStaticMarkup(
      <RunActionAffordances runId="run-2" bankId="banreservas" status="failed" />,
    );
    const runNowButton = html.match(/<button[^>]*data-action="run-now"[^>]*>Ejecutar ahora<\/button>/)?.[0];

    expect(runNowButton).toBeDefined();
    expect(runNowButton).toContain('disabled=""');
    expect(runNowButton).toContain('aria-disabled="true"');
    // The aria-label is what screen readers actually announce; the tooltip
    // body lives in a Radix Portal that is not rendered into the static
    // markup, so we assert on the button-level announcement instead.
    expect(runNowButton).toContain(
      'aria-label="Banco no soportado para corridas manuales"',
    );
  });

  it("disables run-now when the run is already queued or running to prevent duplicate ingestion", () => {
    const queuedHtml = renderToStaticMarkup(
      <RunActionAffordances runId="run-3" bankId="popular" status="queued" />,
    );
    const runningHtml = renderToStaticMarkup(
      <RunActionAffordances runId="run-4" bankId="popular" status="running" />,
    );
    const queuedRunNow = queuedHtml.match(/<button[^>]*data-action="run-now"[^>]*>(?:Ejecutar ahora|En cola…)<\/button>/)?.[0];
    const runningRunNow = runningHtml.match(/<button[^>]*data-action="run-now"[^>]*>(?:Ejecutar ahora|En cola…)<\/button>/)?.[0];

    expect(queuedRunNow).toBeDefined();
    expect(queuedRunNow).toContain('disabled=""');
    expect(queuedRunNow).toContain('aria-disabled="true"');
    expect(runningRunNow).toBeDefined();
    expect(runningRunNow).toContain('disabled=""');
    expect(runningRunNow).toContain('aria-disabled="true"');
  });

  it("renders the localized status label for every status and never falls back to the raw underscore string", () => {
    const cases = [
      { status: "queued", label: "En cola" },
      { status: "running", label: "En curso" },
      { status: "succeeded", label: "Completada" },
      { status: "failed", label: "Fallida" },
      { status: "needs_admin_action", label: "Necesita acción administrativa" },
    ] as const;

    for (const { status, label } of cases) {
      const html = renderToStaticMarkup(
        <RunActionAffordances runId="run-s" bankId="popular" status={status} />,
      );
      expect(html).toContain(`Estado actual: ${label}`);
      // The raw underscored status must NEVER leak into the operator UI.
      expect(html).not.toContain(status.replace(/_/g, " "));
    }
  });

  it("uses the bank display name (Banco Popular) in the success toast, not the raw bankId", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          run: { runId: "run-1", bankId: "popular", accountFingerprint: "a", status: "queued" },
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      ),
    );
    const onSuccess = vi.fn();

    await triggerRunNowForBank({ bankId: "popular", fetchImpl, onSuccess });

    expect(toast.success).toHaveBeenCalledWith(
      "Nueva corrida de Banco Popular en cola — procesándose.",
    );
    // No raw bankId string should appear in the toast message.
    const successMessage = vi.mocked(toast.success).mock.calls[0]?.[0] as string;
    expect(successMessage).not.toMatch(/de popular /);
  });
});

describe("createRunNowClickHandler — duplicate-click guard", () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  afterEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("fires exactly one POST and one success toast when invoked twice while the first request is in flight", async () => {
    let resolveFetch: (response: Response) => void = () => undefined;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      () => new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const onSuccess = vi.fn();
    let pending = false;
    const setPending = vi.fn((value: boolean) => {
      pending = value;
    });

    const handleClick = createRunNowClickHandler({
      bankId: "popular",
      isSupportedBank: true,
      isPending: pending,
      setPending,
      fetchImpl,
      onSuccess,
    });

    handleClick();
    // The handler sets pending=true synchronously after the first call.
    expect(setPending).toHaveBeenLastCalledWith(true);

    // Simulate a fast second click before the first request resolves.
    // The guard reads isPending=true (we flip the local mirror to mirror
    // what the component does after re-render).
    const secondHandler = createRunNowClickHandler({
      bankId: "popular",
      isSupportedBank: true,
      isPending: pending,
      setPending,
      fetchImpl,
      onSuccess,
    });
    secondHandler();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();

    // Resolve the first request and wait for the finally() to release.
    resolveFetch(
      new Response(
        JSON.stringify({
          run: { runId: "run-dup", bankId: "popular", accountFingerprint: "a", status: "queued" },
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      ),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(setPending).toHaveBeenLastCalledWith(false);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("never fires the request when the bank is unsupported", () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const onSuccess = vi.fn();
    const setPending = vi.fn();

    const handleClick = createRunNowClickHandler({
      bankId: "banreservas",
      isSupportedBank: false,
      isPending: false,
      setPending,
      fetchImpl,
      onSuccess,
    });

    handleClick();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(setPending).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Este banco aún no está disponible para corridas manuales.",
    );
  });
});

describe("scrapeRunStatusLabel / bankDisplayName — label maps", () => {
  it("maps every supported status to an operator-facing Spanish label", () => {
    expect(scrapeRunStatusLabel("queued")).toBe("En cola");
    expect(scrapeRunStatusLabel("running")).toBe("En curso");
    expect(scrapeRunStatusLabel("succeeded")).toBe("Completada");
    expect(scrapeRunStatusLabel("failed")).toBe("Fallida");
    expect(scrapeRunStatusLabel("needs_admin_action")).toBe("Necesita acción administrativa");
  });

  it("maps every supported bankId to its display name (no raw id leakage)", () => {
    expect(bankDisplayName("popular")).toBe("Banco Popular");
    expect(bankDisplayName("banreservas")).toBe("Banreservas");
    expect(bankDisplayName("bhd")).toBe("BHD");
  });

  it("falls back to the raw bankId when no display name is registered (defensive)", () => {
    expect(bankDisplayName("unknown-bank")).toBe("unknown-bank");
  });
});

describe("triggerRunNowForBank — request contract", () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  afterEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("sends Content-Type application/json with a { bankId } body for the per-card bank", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          run: { runId: "run-1", bankId: "popular", accountFingerprint: "a", status: "queued" },
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      ),
    );
    const onSuccess = vi.fn();

    await triggerRunNowForBank({ bankId: "popular", fetchImpl, onSuccess });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/scrape-runs/run-now");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(init?.body).toBe(JSON.stringify({ bankId: "popular" }));
    expect(toast.success).toHaveBeenCalledWith(
      "Nueva corrida de Banco Popular en cola — procesándose.",
    );
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});

describe("triggerRunNowForBank — unsupported bank", () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  afterEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("refuses to send a request for an unsupported bank and surfaces an explicit toast", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const onSuccess = vi.fn();

    await triggerRunNowForBank({ bankId: "banreservas", fetchImpl, onSuccess });

    // Never reached the network — no misleading "queued" toast.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "Este banco aún no está disponible para corridas manuales.",
    );
  });
});

describe("triggerRunNowForBank — failure paths (no leaked error.message)", () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  afterEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("surfaces a generic Spanish failure toast and never leaks the raw backend error on 500", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "Postgres ECONNREFUSED 127.0.0.1:5432 stack:..." }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ),
    );
    const onSuccess = vi.fn();

    await triggerRunNowForBank({ bankId: "popular", fetchImpl, onSuccess });

    expect(toast.error).toHaveBeenCalledTimes(1);
    const message = vi.mocked(toast.error).mock.calls[0]?.[0] as string;
    expect(message).toBe("No se pudo programar la corrida. Inténtalo nuevamente.");
    expect(message).not.toContain("Postgres");
    expect(message).not.toContain("ECONNREFUSED");
    expect(message).not.toContain("stack");
    expect(toast.success).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("surfaces a generic failure toast when the network request throws", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );
    const onSuccess = vi.fn();

    await triggerRunNowForBank({ bankId: "popular", fetchImpl, onSuccess });

    expect(toast.error).toHaveBeenCalledTimes(1);
    const message = vi.mocked(toast.error).mock.calls[0]?.[0] as string;
    expect(message).toBe("No se pudo programar la corrida. Inténtalo nuevamente.");
    expect(message).not.toContain("fetch");
    expect(toast.success).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("surfaces a specific conflict toast on 409 when an active run already exists", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "An active scrape run already exists for this bank" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );
    const onSuccess = vi.fn();

    await triggerRunNowForBank({ bankId: "popular", fetchImpl, onSuccess });

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "Ya hay una corrida activa para este banco. Espera a que finalice.",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
