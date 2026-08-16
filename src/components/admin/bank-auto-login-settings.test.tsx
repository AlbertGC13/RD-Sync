import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  BankAutoLoginSettings,
  canSubmitCredentials,
  credentialActionForMetadata,
  fetchCredentialMetadata,
  saveBankCredentials,
  toggleAutoLogin,
  fetchManualRecoveryEligibility,
  resolveManualRecovery,
} from "./bank-auto-login-settings";

describe("BankAutoLoginSettings", () => {
  it("renders an admin-only credential form and auto-login toggle without secret values", () => {
    const html = renderToStaticMarkup(
      <BankAutoLoginSettings bankCode="popular" bankName="Banco Popular" />,
    );

    expect(html).toContain("Configuración de auto-login");
    expect(html).toContain("Banco Popular");
    expect(html).toContain("Usuario del banco");
    expect(html).toContain("Contraseña del banco");
    expect(html).toContain("Activar auto-login");
    expect(html).toContain("Guardar credenciales");
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("password=");
  });

  it("reads metadata without treating an unconfigured bank as an unsafe error", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));

    await expect(fetchCredentialMetadata("popular", fetchImpl)).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith("/api/bank-credentials?bankCode=popular");
  });

  it("prevents credential submission until metadata lookup is confirmed", () => {
    expect(canSubmitCredentials("loading")).toBe(false);
    expect(canSubmitCredentials("failed")).toBe(false);
    expect(canSubmitCredentials("absent")).toBe(true);
    expect(canSubmitCredentials("present")).toBe(true);
  });

  it("chooses rotation only after confirmed credential presence", () => {
    expect(credentialActionForMetadata("absent")).toBe("set");
    expect(credentialActionForMetadata("present")).toBe("rotate");
  });

  it("renders the persisted enabled state from credential metadata", () => {
    const html = renderToStaticMarkup(
      <BankAutoLoginSettings bankCode="popular" bankName="Banco Popular" initialAutoLoginEnabled />,
    );

    expect(html).toContain("Estado: Activado");
    expect(html).toContain("Desactivar auto-login");
  });

  it("posts credential fields only to the credential endpoint and never exposes backend errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: "secret" }), { status: 503 }));

    await expect(saveBankCredentials({
      bankCode: "popular",
      action: "set",
      username: "bank-user",
      password: "bank-password",
      fetchImpl,
    })).resolves.toBe(false);

    expect(fetchImpl).toHaveBeenCalledWith("/api/bank-credentials", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ action: "set", bankCode: "popular", username: "bank-user", password: "bank-password" }),
    }));
  });

  it("toggles one bank through the PR4.8a1 endpoint with an exact boolean payload", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      bankCode: "popular",
      autoLoginEnabled: true,
    }), { status: 200 }));

    await expect(toggleAutoLogin({ bankCode: "popular", enabled: true, fetchImpl })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/bank-credentials/popular/auto-login",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ enabled: true }) }),
    );
  });

  it("uses the manual recovery endpoint without exposing episode details to the browser", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ eligible: true }), { status: 200 }));

    await expect(fetchManualRecoveryEligibility("popular", fetchImpl)).resolves.toBe(true);
    await expect(resolveManualRecovery({ bankCode: "popular", decision: { outcome: "resolved_no_retry", reason: "closed_without_retry" }, fetchImpl })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "/api/bank-sessions/manual-recovery?bankCode=popular",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ decision: { outcome: "resolved_no_retry", reason: "closed_without_retry" } }) }),
    );
  });
});
