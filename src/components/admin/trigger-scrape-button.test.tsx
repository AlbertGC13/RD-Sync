import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  DEFAULT_RUN_NOW_BANK_CODE,
  SUPPORTED_RUN_NOW_BANK_CODES,
  isSupportedRunNowBankCode,
  triggerRunNow,
} from "./trigger-scrape-button";
import { toast } from "sonner";

describe("SUPPORTED_RUN_NOW_BANK_CODES — bankCode whitelist", () => {
  it("exposes Popular as the only currently supported bank", () => {
    expect(SUPPORTED_RUN_NOW_BANK_CODES).toEqual(["popular"]);
    expect(DEFAULT_RUN_NOW_BANK_CODE).toBe("popular");
  });

  it("recognises popular as supported and rejects every other bankCode", () => {
    expect(isSupportedRunNowBankCode("popular")).toBe(true);
    expect(isSupportedRunNowBankCode("banreservas")).toBe(false);
    expect(isSupportedRunNowBankCode("bhd")).toBe(false);
    expect(isSupportedRunNowBankCode("")).toBe(false);
  });
});

describe("triggerRunNow — request contract", () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  afterEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("sends Content-Type application/json with a { bankId } body for the provided bank", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          run: { runId: "run-x", bankId: "banreservas", accountFingerprint: "a", status: "queued" },
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      ),
    );
    const onSuccess = vi.fn();

    await triggerRunNow({ bankId: "popular", fetchImpl, onSuccess });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/scrape-runs/run-now");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(init?.body).toBe(JSON.stringify({ bankId: "popular" }));
    expect(toast.success).toHaveBeenCalledWith("Nueva corrida en cola — procesándose.");
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});

describe("triggerRunNow — default-bank path (no bankId provided)", () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  afterEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("uses the Popular default when no bankId is provided (the actual page-level path)", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          run: { runId: "run-y", bankId: "popular", accountFingerprint: "a", status: "queued" },
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      ),
    );
    const onSuccess = vi.fn();

    // Note: bankId is intentionally omitted — this exercises the real default path
    // used by the page-level TriggerScrapeButton when no card is selected.
    await triggerRunNow({ fetchImpl, onSuccess });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.body).toBe(JSON.stringify({ bankId: "popular" }));
    expect(toast.success).toHaveBeenCalledWith("Nueva corrida en cola — procesándose.");
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});

describe("triggerRunNow — failure paths (no leaked error.message)", () => {
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

    await triggerRunNow({ bankId: "popular", fetchImpl, onSuccess });

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

    await triggerRunNow({ bankId: "popular", fetchImpl, onSuccess });

    expect(toast.error).toHaveBeenCalledTimes(1);
    const message = vi.mocked(toast.error).mock.calls[0]?.[0] as string;
    expect(message).toBe("No se pudo programar la corrida. Inténtalo nuevamente.");
    expect(message).not.toContain("fetch");
    expect(toast.success).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("surfaces the generic failure toast when the backend rejects an unsupported bank", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "Bank not currently supported for manual runs" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );
    const onSuccess = vi.fn();

    await triggerRunNow({ bankId: "banreservas", fetchImpl, onSuccess });

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "No se pudo programar la corrida. Inténtalo nuevamente.",
    );
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

    await triggerRunNow({ bankId: "popular", fetchImpl, onSuccess });

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "Ya hay una corrida activa para este banco. Espera a que finalice.",
    );
    // The generic failure toast must NOT also fire.
    expect(toast.error).not.toHaveBeenCalledWith(
      "No se pudo programar la corrida. Inténtalo nuevamente.",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
