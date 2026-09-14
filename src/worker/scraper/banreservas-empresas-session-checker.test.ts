import { describe, expect, it } from "vitest";

import {
  banreservasEmpresasTrustedPath,
  createBanreservasEmpresasReadonlySessionChecker,
  type BanreservasEmpresasFrameName,
  type BanreservasEmpresasFrameObservation,
} from "./banreservas-empresas-session-checker";

const origin = "https://www.banreservas.com.do";
const frameset = { topFrame: `${origin}/TuBancoEmpresas/Header.aspx`, leftFrame: `${origin}/TuBancoEmpresas/Menu.aspx`, mainFrame: `${origin}/TuBancoEmpresas/Home.aspx` };

function page(url: string, options: { frames?: Partial<Record<BanreservasEmpresasFrameName, string>>; headerMarker?: boolean; loginEvidence?: boolean; throwOn?: keyof BanreservasEmpresasFrameObservation } = {}): BanreservasEmpresasFrameObservation {
  const fail = (name: keyof BanreservasEmpresasFrameObservation) => { if (options.throwOn === name) throw new Error("portal details must not escape"); };
  return {
    async currentUrl() { fail("currentUrl"); return url; },
    async frameUrl(name) { fail("frameUrl"); return options.frames?.[name]; },
    async hasAuthenticatedHeaderMarker() { fail("hasAuthenticatedHeaderMarker"); return options.headerMarker ?? false; },
    async hasLoginPageEvidence() { fail("hasLoginPageEvidence"); return options.loginEvidence ?? false; },
  };
}

describe("banreservasEmpresasTrustedPath", () => {
  it("returns the pathname only for the exact https portal origin without credentials", () => {
    expect(banreservasEmpresasTrustedPath(`${origin}/TuBancoEmpresas/Default.aspx?x=1#y`)).toBe("/TuBancoEmpresas/Default.aspx");
    for (const hostile of ["http://www.banreservas.com.do/TuBancoEmpresas/Default.aspx", "https://banreservas.com.do/TuBancoEmpresas/Default.aspx", "https://user:pass@www.banreservas.com.do/TuBancoEmpresas/Default.aspx", "https://evil.test/TuBancoEmpresas/Default.aspx", "not a url", ""]) {
      expect(banreservasEmpresasTrustedPath(hostile)).toBeUndefined();
    }
  });
});

describe("Banreservas Empresas read-only session checker", () => {
  const clock = () => new Date("2026-09-13T00:00:00.000Z");
  const check = (observation: BanreservasEmpresasFrameObservation) => createBanreservasEmpresasReadonlySessionChecker({ page: observation, clock }).check();
  const active = { status: "active", checkedAt: "2026-09-13T00:00:00.000Z", safeSummary: "Banreservas Empresas session is active." };
  const expired = { status: "expired", checkedAt: "2026-09-13T00:00:00.000Z", safeSummary: "Banreservas Empresas sign-in is required." };
  const unavailable = { status: "browser_unavailable", checkedAt: "2026-09-13T00:00:00.000Z", safeSummary: "Banreservas Empresas session is unavailable." };

  it("reports active only for the trusted frameset with header, menu, a portal main frame, and the logout marker", async () => {
    for (const mainFrame of [frameset.mainFrame, `${origin}/TuBancoEmpresas/Pages/Accounts/Accounts.aspx`, `${origin}/TuBancoEmpresas/Pages/Common/ProductStatus.aspx?k=v`]) {
      await expect(check(page(`${origin}/TuBancoEmpresas/Default.aspx`, { frames: { ...frameset, mainFrame }, headerMarker: true }))).resolves.toEqual(active);
    }
  });

  it("reports expiration for the trusted login page or a main frame bounced to it, only with login-page evidence", async () => {
    await expect(check(page(`${origin}/TuBancoEmpresas/Login.aspx`, { loginEvidence: true }))).resolves.toEqual(expired);
    await expect(check(page(`${origin}/TuBancoEmpresas/Default.aspx`, { frames: { ...frameset, mainFrame: `${origin}/TuBancoEmpresas/Login.aspx` }, headerMarker: true, loginEvidence: true }))).resolves.toEqual(expired);
    await expect(check(page(`${origin}/TuBancoEmpresas/Login.aspx`))).resolves.toEqual(unavailable);
  });

  it("fails closed for missing markers, wrong frames, foreign routes, hostile URLs, and observation errors", async () => {
    const framesetPage = (overrides: Parameters<typeof page>[1]) => page(`${origin}/TuBancoEmpresas/Default.aspx`, { frames: frameset, headerMarker: true, ...overrides });
    for (const observation of [
      framesetPage({ headerMarker: false }),
      framesetPage({ frames: { ...frameset, topFrame: `${origin}/TuBancoEmpresas/Menu.aspx` } }),
      framesetPage({ frames: { ...frameset, leftFrame: undefined } }),
      framesetPage({ frames: { ...frameset, mainFrame: `${origin}/Other/Home.aspx` } }),
      framesetPage({ frames: { ...frameset, mainFrame: "https://evil.test/TuBancoEmpresas/Home.aspx" } }),
      page(`${origin}/TuBancoEmpresas/Home.aspx`, { frames: frameset, headerMarker: true }),
      page("https://evil.test/TuBancoEmpresas/Default.aspx", { frames: frameset, headerMarker: true }),
      page(`https://user:pass@www.banreservas.com.do/TuBancoEmpresas/Login.aspx`, { loginEvidence: true }),
      framesetPage({ throwOn: "currentUrl" }),
      framesetPage({ throwOn: "hasAuthenticatedHeaderMarker" }),
    ]) await expect(check(observation)).resolves.toEqual(unavailable);
  });
});
