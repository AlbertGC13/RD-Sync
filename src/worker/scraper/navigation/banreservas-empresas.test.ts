import { describe, expect, it } from "vitest";

import {
  collectBanreservasEmpresasMovements,
  deriveBanreservasEmpresasAccountFingerprint,
  resolveBanreservasEmpresasPeriod,
  type BanreservasEmpresasAccessState,
  type BanreservasEmpresasPage,
} from "./banreservas-empresas";

const creditRow = ["29/06/26", "TXN-EXAMPLE-001", "PAYMENT RECEIVED", "0.00", "1,250.00", "DOP 9,999.99"];
const debitRow = ["28/06/26", "   ", "SERVICE CHARGE", "9.75", "0.00", "DOP 9,990.24"];
const clock = () => new Date("2026-09-13T15:00:00.000Z");

type AccountScript = { key?: string; pages: readonly (readonly (readonly string[])[])[]; nextAfterLastPage?: boolean };

class FakePage implements BanreservasEmpresasPage {
  readonly operations: string[] = [];
  private account = -1;
  private pageIndex = 0;

  constructor(private readonly state: {
    accessState?: BanreservasEmpresasAccessState;
    accounts?: readonly AccountScript[];
    fail?: Partial<Record<"openAccountsQuery" | "selectAccountRow" | "setPeriod" | "runQuery" | "goToNextPage", boolean>>;
    throwOn?: keyof BanreservasEmpresasPage;
  } = {}) {}

  private step(name: keyof BanreservasEmpresasPage, detail = ""): void {
    this.operations.push(detail ? `${name}:${detail}` : name);
    if (this.state.throwOn === name) throw new Error("portal contents must not escape");
  }

  private get script(): AccountScript { return this.state.accounts?.[this.account] ?? { pages: [] }; }

  async accessState() { this.step("accessState"); return this.state.accessState ?? "authenticated"; }
  async openAccountsQuery() { this.step("openAccountsQuery"); return !this.state.fail?.openAccountsQuery; }
  async countAccountRows() { this.step("countAccountRows"); return this.state.accounts?.length ?? 0; }
  async selectAccountRow(index: number) { this.step("selectAccountRow", String(index)); this.account = index; this.pageIndex = 0; return !this.state.fail?.selectAccountRow; }
  async selectedAccountKey() { this.step("selectedAccountKey"); return this.script.key ?? `key-${this.account}`; }
  async setPeriod(period: { from: string; to: string }) { this.step("setPeriod", `${period.from}..${period.to}`); return !this.state.fail?.setPeriod; }
  async runQuery() { this.step("runQuery"); return !this.state.fail?.runQuery; }
  async readVisibleTransactionRows() { this.step("readVisibleTransactionRows"); return this.script.pages[this.pageIndex] ?? []; }
  async hasNextPage() { this.step("hasNextPage"); return this.pageIndex < this.script.pages.length - 1 || (this.script.nextAfterLastPage ?? false); }
  async goToNextPage() { this.step("goToNextPage"); if (this.state.fail?.goToNextPage) return false; this.pageIndex += 1; return true; }
}

describe("collectBanreservasEmpresasMovements", () => {
  it("collects every account deterministically across pages, deduplicating rows and separating fingerprints", async () => {
    const page = new FakePage({ accounts: [
      { key: "TYPE_1", pages: [[creditRow], [debitRow, creditRow], []] },
      { key: "TYPE_2", pages: [[debitRow]] },
    ] });

    const result = await collectBanreservasEmpresasMovements(page, { clock, lookbackDays: 30 });

    expect(result.status).toBe("collected");
    expect(result.movements.map((movement) => [movement.accountFingerprint, movement.direction, movement.amount])).toEqual([
      [deriveBanreservasEmpresasAccountFingerprint("TYPE_1"), "credit", "1250.00"],
      [deriveBanreservasEmpresasAccountFingerprint("TYPE_1"), "debit", "9.75"],
      [deriveBanreservasEmpresasAccountFingerprint("TYPE_2"), "debit", "9.75"],
    ]);
    expect(result.movements.every((movement) => movement.bankId === "banreservas_empresas")).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/TYPE_1|TYPE_2|9,999|9,990/);
    expect(page.operations).toEqual([
      "accessState", "openAccountsQuery", "countAccountRows",
      "selectAccountRow:0", "selectedAccountKey", "setPeriod:14/08/2026..13/09/2026", "runQuery",
      "readVisibleTransactionRows", "hasNextPage", "goToNextPage", "readVisibleTransactionRows", "hasNextPage", "goToNextPage", "readVisibleTransactionRows",
      "openAccountsQuery", "selectAccountRow:1", "selectedAccountKey", "setPeriod:14/08/2026..13/09/2026", "runQuery",
      "readVisibleTransactionRows", "hasNextPage",
    ]);
  });

  it("treats an empty first page as a complete empty result without paging further", async () => {
    const page = new FakePage({ accounts: [{ pages: [[]], nextAfterLastPage: true }] });
    await expect(collectBanreservasEmpresasMovements(page, { clock })).resolves.toEqual({ status: "collected", movements: [] });
    expect(page.operations).not.toContain("goToNextPage");
  });

  it("reports login as administrator action and unknown access or missing accounts as unavailable", async () => {
    await expect(collectBanreservasEmpresasMovements(new FakePage({ accessState: "login" }), { clock }))
      .resolves.toEqual({ status: "needs_admin_action", movements: [], safeErrorSummary: "Banreservas Empresas session requires administrator action." });
    await expect(collectBanreservasEmpresasMovements(new FakePage({ accessState: "unknown" }), { clock }))
      .resolves.toEqual({ status: "unavailable", movements: [], safeErrorSummary: "Banreservas Empresas page is unavailable." });
    await expect(collectBanreservasEmpresasMovements(new FakePage({ accounts: [] }), { clock }))
      .resolves.toEqual({ status: "unavailable", movements: [], safeErrorSummary: "Banreservas Empresas accounts are unavailable." });
  });

  it("fails closed without partial movements on navigation, paging, parsing, and observation failures", async () => {
    const twoPages: AccountScript = { pages: [[creditRow], [debitRow]] };
    const scenarios: Array<[FakePage, string]> = [
      [new FakePage({ accounts: [twoPages], fail: { openAccountsQuery: true } }), "Banreservas Empresas accounts are unavailable."],
      [new FakePage({ accounts: [twoPages], fail: { selectAccountRow: true } }), "Banreservas Empresas accounts are unavailable."],
      [new FakePage({ accounts: [{ ...twoPages, key: "   " }] }), "Banreservas Empresas accounts are unavailable."],
      [new FakePage({ accounts: [twoPages], fail: { setPeriod: true } }), "Banreservas Empresas movements are unavailable."],
      [new FakePage({ accounts: [twoPages], fail: { runQuery: true } }), "Banreservas Empresas movements are unavailable."],
      [new FakePage({ accounts: [twoPages], fail: { goToNextPage: true } }), "Banreservas Empresas movements could not be fully paged."],
      [new FakePage({ accounts: [{ pages: [[creditRow], [creditRow]], nextAfterLastPage: true }] }), "Banreservas Empresas movements could not be fully paged."],
      [new FakePage({ accounts: [{ pages: Array.from({ length: 4 }, (_, index) => [[`0${index + 1}/09/26`, "", "ROW", "1.00", "0.00", "DOP 1.00"]]), nextAfterLastPage: true }] }), "Banreservas Empresas movements could not be fully paged."],
      [new FakePage({ accounts: [{ pages: [[creditRow.slice(0, 5)]] }] }), "Banreservas Empresas movements could not be safely parsed."],
      [new FakePage({ accounts: [{ pages: [[[...creditRow.slice(0, 3), "1.00", "2.00", "DOP 1.00"]]] }] }), "Banreservas Empresas movements could not be safely parsed."],
      [new FakePage({ accounts: [twoPages], throwOn: "readVisibleTransactionRows" }), "Banreservas Empresas movements are unavailable."],
      [new FakePage({ accounts: [twoPages], throwOn: "accessState" }), "Banreservas Empresas movements are unavailable."],
    ];
    for (const [page, safeErrorSummary] of scenarios) {
      await expect(collectBanreservasEmpresasMovements(page, { clock, maxPagesPerAccount: 3 })).resolves.toEqual({ status: "unavailable", movements: [], safeErrorSummary });
    }
  });
});

describe("resolveBanreservasEmpresasPeriod", () => {
  it("formats the Santo Domingo calendar window as DD/MM/YYYY with a bounded lookback", () => {
    expect(resolveBanreservasEmpresasPeriod(new Date("2026-09-13T03:30:00.000Z"), 30)).toEqual({ from: "13/08/2026", to: "12/09/2026" });
    expect(resolveBanreservasEmpresasPeriod(new Date("2026-03-01T12:00:00.000Z"), 1)).toEqual({ from: "28/02/2026", to: "01/03/2026" });
    expect(resolveBanreservasEmpresasPeriod(new Date("2026-09-13T12:00:00.000Z"), 500)).toEqual({ from: "15/06/2026", to: "13/09/2026" });
    expect(resolveBanreservasEmpresasPeriod(new Date("2026-09-13T12:00:00.000Z"), Number.NaN)).toEqual({ from: "14/08/2026", to: "13/09/2026" });
  });
});

describe("deriveBanreservasEmpresasAccountFingerprint", () => {
  it("derives a stable opaque fingerprint that never embeds the portal key", () => {
    const fingerprint = deriveBanreservasEmpresasAccountFingerprint("TYPE_12345678");
    expect(fingerprint).toMatch(/^banreservas_empresas-[0-9a-f]{10}$/);
    expect(fingerprint).toBe(deriveBanreservasEmpresasAccountFingerprint("TYPE_12345678"));
    expect(fingerprint).not.toBe(deriveBanreservasEmpresasAccountFingerprint("TYPE_12345679"));
    expect(fingerprint).not.toContain("12345678");
  });
});
