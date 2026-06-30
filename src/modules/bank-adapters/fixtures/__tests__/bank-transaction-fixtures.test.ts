import { describe, expect, it } from "vitest";
import { bhdPersonalTransactions, BHD_PERSONAL_BANK_CODE, BHD_PERSONAL_PORTAL_VARIANT } from "../bhd-personal";
import { banreservasPersonasTransactions, BANRESERVAS_PERSONAS_BANK_CODE, BANRESERVAS_PERSONAS_PORTAL_VARIANT } from "../banreservas-personas";
import { banreservasEmpresasTransactions, BANRESERVAS_EMPRESAS_BANK_CODE, BANRESERVAS_EMPRESAS_PORTAL_VARIANT } from "../banreservas-empresas";
import { containsSensitiveData, normalizeFixtureText } from "../helpers";

// ---------------------------------------------------------------------------
// Per-bank fixture contracts
// ---------------------------------------------------------------------------

describe("BHD Personal transaction fixtures", () => {
  it("has transactions with all required fields", () => {
    expect(bhdPersonalTransactions.length).toBeGreaterThanOrEqual(1);
    for (const tx of bhdPersonalTransactions) {
      expect(typeof tx.date).toBe("string");
      expect(tx.date.length).toBeGreaterThan(0);
      expect(typeof tx.confirmationNumber).toBe("string");
      expect(tx.confirmationNumber.length).toBeGreaterThan(0);
      expect(typeof tx.description).toBe("string");
      expect(tx.description.length).toBeGreaterThan(0);
      expect(typeof tx.receipt).toBe("string");
      expect(typeof tx.debit).toBe("string");
      expect(typeof tx.credit).toBe("string");
      expect(typeof tx.balance).toBe("string");
    }
  });

  it("uses DD/MM/YYYY date format", () => {
    for (const tx of bhdPersonalTransactions) {
      expect(tx.date).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    }
  });

  it("includes both credit and debit transactions", () => {
    expect(bhdPersonalTransactions.some((tx) => tx.credit !== "")).toBe(true);
    expect(bhdPersonalTransactions.some((tx) => tx.debit !== "")).toBe(true);
  });

  it("amounts and balance use RD$ prefix with comma-separated thousands", () => {
    for (const tx of bhdPersonalTransactions) {
      if (tx.debit !== "") expect(tx.debit).toMatch(/^RD\$ [\d,]+\.\d{2}$/);
      if (tx.credit !== "") expect(tx.credit).toMatch(/^RD\$ [\d,]+\.\d{2}$/);
      expect(tx.balance).toMatch(/^RD\$ [\d,]+\.\d{2}$/);
    }
  });

  it("contains no PII or sensitive data", () => {
    expect(containsSensitiveData(JSON.stringify(bhdPersonalTransactions))).toBe(false);
  });
});

describe("Banreservas Personas transaction fixtures", () => {
  it("has transactions with all required fields", () => {
    expect(banreservasPersonasTransactions.length).toBeGreaterThanOrEqual(1);
    for (const tx of banreservasPersonasTransactions) {
      expect(typeof tx.date).toBe("string");
      expect(tx.date.length).toBeGreaterThan(0);
      expect(typeof tx.description).toBe("string");
      expect(typeof tx.reference).toBe("string");
      expect(tx.reference.length).toBeGreaterThan(0);
      expect(typeof tx.debit).toBe("string");
      expect(typeof tx.credit).toBe("string");
      expect(typeof tx.balance).toBe("string");
    }
  });

  it("uses DD/MM/YYYY date format", () => {
    for (const tx of banreservasPersonasTransactions) {
      expect(tx.date).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    }
  });

  it("includes both credit and debit transactions", () => {
    expect(banreservasPersonasTransactions.some((tx) => tx.credit !== "")).toBe(true);
    expect(banreservasPersonasTransactions.some((tx) => tx.debit !== "")).toBe(true);
  });

  it("amounts and balance use comma-separated thousands with 2 decimals (no currency prefix)", () => {
    for (const tx of banreservasPersonasTransactions) {
      if (tx.debit !== "") expect(tx.debit).toMatch(/^-?[\d,]+\.\d{2}$/);
      if (tx.credit !== "") expect(tx.credit).toMatch(/^-?[\d,]+\.\d{2}$/);
      expect(tx.balance).toMatch(/^[\d,]+\.\d{2}$/);
    }
  });

  it("reference field contains transaction IDs with '# Nro. transacción' prefix", () => {
    for (const tx of banreservasPersonasTransactions) {
      expect(tx.reference).toMatch(/^# Nro\. transacción/);
      expect(tx.reference).toMatch(/\d{5,}/);
    }
  });

  it("contains no PII or sensitive data", () => {
    expect(containsSensitiveData(JSON.stringify(banreservasPersonasTransactions))).toBe(false);
  });
});

describe("Banreservas Empresas transaction fixtures", () => {
  it("has transactions with all required fields", () => {
    expect(banreservasEmpresasTransactions.length).toBeGreaterThanOrEqual(1);
    for (const tx of banreservasEmpresasTransactions) {
      expect(typeof tx.date).toBe("string");
      expect(tx.date.length).toBeGreaterThan(0);
      expect(typeof tx.transactionNumber).toBe("string");
      expect(tx.transactionNumber.length).toBeGreaterThan(0);
      expect(typeof tx.description).toBe("string");
      expect(typeof tx.debit).toBe("string");
      expect(typeof tx.credit).toBe("string");
      expect(typeof tx.balance).toBe("string");
    }
  });

  it("uses DD/MM/YY date format (2-digit year)", () => {
    for (const tx of banreservasEmpresasTransactions) {
      expect(tx.date).toMatch(/^\d{2}\/\d{2}\/\d{2}$/);
    }
  });

  it("includes both positive credit and positive debit amounts", () => {
    const hasPositiveCredit = banreservasEmpresasTransactions.some(
      (tx) => tx.credit !== "" && parseFloat(tx.credit.replace(/,/g, "")) > 0
    );
    const hasPositiveDebit = banreservasEmpresasTransactions.some(
      (tx) => tx.debit !== "" && parseFloat(tx.debit.replace(/,/g, "")) > 0
    );
    expect(hasPositiveCredit).toBe(true);
    expect(hasPositiveDebit).toBe(true);
  });

  it("amounts have no currency prefix in debit/credit columns", () => {
    for (const tx of banreservasEmpresasTransactions) {
      if (tx.debit !== "") expect(tx.debit).toMatch(/^\d[\d,]*\.\d{2}$/);
      if (tx.credit !== "") expect(tx.credit).toMatch(/^\d[\d,]*\.\d{2}$/);
    }
  });

  it("balance uses DOP prefix with comma-separated thousands", () => {
    for (const tx of banreservasEmpresasTransactions) {
      expect(tx.balance).toMatch(/^DOP [\d,]+\.\d{2}$/);
    }
  });

  it("contains no PII or sensitive data", () => {
    expect(containsSensitiveData(JSON.stringify(banreservasEmpresasTransactions))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixture metadata — portal variant disambiguation
// ---------------------------------------------------------------------------

describe("Fixture metadata — bank code + portal variant", () => {
  it.each([
    ["BHD Personal", BHD_PERSONAL_BANK_CODE, BHD_PERSONAL_PORTAL_VARIANT, "bhd", "personal"],
    ["Banreservas Personas", BANRESERVAS_PERSONAS_BANK_CODE, BANRESERVAS_PERSONAS_PORTAL_VARIANT, "banreservas", "personas"],
    ["Banreservas Empresas", BANRESERVAS_EMPRESAS_BANK_CODE, BANRESERVAS_EMPRESAS_PORTAL_VARIANT, "banreservas", "empresas"],
  ])("%s exports correct bank code and portal variant", (_label, bankCode, portalVariant, expectedBank, expectedVariant) => {
    expect(bankCode).toBe(expectedBank);
    expect(portalVariant).toBe(expectedVariant);
  });

  it("Banreservas Personas and Empresas share bank code but differ by portal variant", () => {
    expect(BANRESERVAS_PERSONAS_BANK_CODE).toBe(BANRESERVAS_EMPRESAS_BANK_CODE);
    expect(BANRESERVAS_PERSONAS_PORTAL_VARIANT).not.toBe(BANRESERVAS_EMPRESAS_PORTAL_VARIANT);
  });
});

// ---------------------------------------------------------------------------
// normalizeFixtureText helper
// ---------------------------------------------------------------------------

describe("normalizeFixtureText", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeFixtureText("  hello   world  ")).toBe("hello world");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeFixtureText("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Cross-fixture sanitization invariants
// ---------------------------------------------------------------------------

describe("Sanitization invariant — all fixtures", () => {
  const combined = JSON.stringify([
    bhdPersonalTransactions,
    banreservasPersonasTransactions,
    banreservasEmpresasTransactions,
  ]);
  const combinedLower = combined.toLowerCase();

  it("contains no IBANs, RNC, or real account numbers", () => {
    expect(combined).not.toMatch(/\bDO\s*[A-Z]{2}\s*\d{2}\s*\d{4}/i);
    expect(combined).not.toMatch(/\b0[1-9]\d{8,}\b/);
    expect(combined).not.toMatch(/\b[1-9]\d{2}-\d{7}\b/);
  });

  it("contains no cookie, token, session, password, or credential patterns", () => {
    for (const term of ["cookie", "session", "token", "password", "credential"]) {
      expect(combinedLower).not.toContain(term);
    }
  });

  it("contains no email addresses", () => {
    expect(combined).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  });
});

// ---------------------------------------------------------------------------
// Regression: containsSensitiveData determinism + detection coverage
// ---------------------------------------------------------------------------

describe("containsSensitiveData", () => {
  it("is deterministic across repeated calls (sensitive input)", () => {
    const sensitive = "Password: abc123";
    for (let i = 0; i < 11; i++) {
      expect(containsSensitiveData(sensitive)).toBe(true);
    }
  });

  it("is deterministic across repeated calls (safe input)", () => {
    const safe = JSON.stringify(bhdPersonalTransactions);
    for (let i = 0; i < 11; i++) {
      expect(containsSensitiveData(safe)).toBe(false);
    }
  });

  it.each([
    ["cédula-like IDs", "Cédula: 000-0000000-0"],
    ["RNC-like tax IDs", "RNC: 101-0000000"],
    ["phone numbers", "Tel: 000-000-0000"],
    ["Visa PAN", "4000-0000-0000-0001"],
    ["Mastercard PAN", "5100 0000 0000 0001"],
    ["JWT Bearer token", "Bearer eyJ0ZXN0.eyJ0ZXN0.eyJ0ZXN0"],
    ["session cookie assignment", "session_id=fake-session-abc123"],
  ])("detects %s", (_label, input) => {
    expect(containsSensitiveData(input)).toBe(true);
  });

  it("does not false-positive on fixture descriptions", () => {
    const fixtureText = JSON.stringify([
      bhdPersonalTransactions,
      banreservasPersonasTransactions,
      banreservasEmpresasTransactions,
    ]);
    expect(containsSensitiveData(fixtureText)).toBe(false);
  });
});
