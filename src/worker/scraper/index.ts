import type { BankMovement, TransactionDirection } from "../../modules/transactions";

export type ScrapeCollectionStatus = "collected" | "needs_admin_action";

export type BankTransactionRow = Record<string, string | null | undefined>;

export interface ReadOnlyScraperProfile {
  bankId: string;
  accountFingerprint: string;
  transactionRowSelector: string;
  mfaIndicatorSelector?: string;
  columnMap: {
    postedAt: string;
    amount: string;
    currency: string;
    direction: string;
    reference?: string;
    concept?: string;
    originator?: string;
  };
}

export interface ReadOnlyBankPage {
  isVisible(selector: string): Promise<boolean>;
  readRows(selector: string): Promise<BankTransactionRow[]>;
  diagnosticText(): Promise<string>;
}

export interface PlaywrightPageLike {
  locator(selector: string): {
    first(): {
      isVisible(): Promise<boolean>;
    };
    evaluateAll<T>(mapper: (elements: Element[]) => T): Promise<T>;
    textContent(): Promise<string | null>;
  };
}

export interface ScrapeCollectionResult {
  status: ScrapeCollectionStatus;
  movements: BankMovement[];
  safeErrorSummary?: string;
}

export interface ReadOnlyBankScraper {
  collect(page: ReadOnlyBankPage): Promise<ScrapeCollectionResult>;
}

const unsafeBankMutationPattern = /\b(transfer|payment|beneficiary|beneficiario|pago|transferencia|wire|ach)\b/i;
const credentialPattern = /\b(password|passwd|pwd|sessionToken|token|cookie|secret|authorization)\s*[:=]\s*[^\s]+/gi;
const accountNumberPattern = /\b\d{10,}\b/g;
const balancePattern = /\b\d{1,3}(?:,\d{3})+\.\d{2}\b/g;
/**
 * Strips credentials from URI connection strings before they can be
 * persisted or displayed. Matches `scheme://[user[:password]@]host[:port]`
 * forms for the drivers RD-Sync might surface in diagnostic text —
 * postgres/postgresql, redis, mongodb (+srv), amqp, and generic db schemes.
 * The userinfo segment (everything between `://` and the next `@` before a
 * path/host boundary) is replaced with `[REDACTED_URI_CREDENTIALS]` while the
 * scheme and host are preserved so operators still see *where* the failure
 * happened without seeing *how* it authenticates.
 */
const uriCredentialPattern =
  /((?:postgres(?:ql)?|redis|rediss|mongodb(?:\+srv)?|amqp|amqps|mssql|mysql|db2):\/\/)([^\s/@:]*(?::[^\s/@]+)?@)/gi;

export function createReadOnlyBankScraper(profile: ReadOnlyScraperProfile): ReadOnlyBankScraper {
  assertReadOnlyProfile(profile);

  return {
    async collect(page) {
      if (profile.mfaIndicatorSelector && (await page.isVisible(profile.mfaIndicatorSelector))) {
        const diagnosticText = await page.diagnosticText();

        return {
          status: "needs_admin_action",
          movements: [],
          safeErrorSummary: `Bank session requires admin MFA action. Diagnostic: ${redactDiagnosticText(diagnosticText)}`,
        };
      }

      const rows = await page.readRows(profile.transactionRowSelector);

      return {
        status: "collected",
        movements: rows.map((row) => mapRowToMovement(row, profile)),
      };
    },
  };
}

export function createPlaywrightReadOnlyPage(page: PlaywrightPageLike): ReadOnlyBankPage {
  return {
    async isVisible(selector) {
      assertSafeReadSelector(selector);
      return page.locator(selector).first().isVisible();
    },
    async readRows(selector) {
      assertSafeReadSelector(selector);

      return page.locator(selector).evaluateAll((elements) =>
        elements.map((element) => {
          const cells = Array.from(element.querySelectorAll("[data-rd-sync-column]"));

          return Object.fromEntries(
            cells.map((cell) => [
              cell.getAttribute("data-rd-sync-column") ?? "",
              cell.textContent?.trim() ?? "",
            ]),
          );
        }),
      );
    },
    async diagnosticText() {
      return page.locator("body").textContent().then((text) => redactDiagnosticText(text ?? ""));
    },
  };
}

export function redactDiagnosticText(value: string): string {
  return value
    // Strip URI userinfo FIRST so the credential pattern below does not
    // leave half-redacted `password=...@host` fragments behind. The scheme
    // and host are preserved; only `user:pass@` is replaced.
    .replace(uriCredentialPattern, "$1[REDACTED_URI_CREDENTIALS]@")
    .replace(credentialPattern, "[REDACTED]")
    .replace(accountNumberPattern, "[REDACTED_ACCOUNT]")
    .replace(balancePattern, "[REDACTED_AMOUNT]")
    .trim();
}

function assertReadOnlyProfile(profile: ReadOnlyScraperProfile): void {
  assertSafeReadSelector(profile.transactionRowSelector);
  if (profile.mfaIndicatorSelector) {
    assertSafeReadSelector(profile.mfaIndicatorSelector);
  }
}

function assertSafeReadSelector(selector: string): void {
  if (unsafeBankMutationPattern.test(selector)) {
    throw new Error("Unsafe bank mutation selector is not allowed in read-only scraping");
  }
}

function mapRowToMovement(row: BankTransactionRow, profile: ReadOnlyScraperProfile): BankMovement {
  return {
    bankId: profile.bankId,
    accountFingerprint: profile.accountFingerprint,
    postedAt: requiredColumn(row, profile.columnMap.postedAt),
    amount: requiredColumn(row, profile.columnMap.amount),
    currency: normalizeCurrency(requiredColumn(row, profile.columnMap.currency)),
    direction: normalizeDirection(requiredColumn(row, profile.columnMap.direction)),
    reference: optionalColumn(row, profile.columnMap.reference),
    concept: optionalColumn(row, profile.columnMap.concept),
    originator: optionalColumn(row, profile.columnMap.originator),
  };
}

function requiredColumn(row: BankTransactionRow, key: string): string {
  const value = row[key]?.trim();
  if (!value) {
    throw new Error(`Missing required transaction column: ${key}`);
  }

  return value;
}

function optionalColumn(row: BankTransactionRow, key: string | undefined): string | null {
  if (!key) return null;
  const value = row[key]?.trim();
  return value ? value : null;
}

function normalizeCurrency(value: string): string {
  return value.toUpperCase();
}

function normalizeDirection(value: string): TransactionDirection {
  const normalized = value.trim().toLowerCase();
  if (normalized === "credit" || normalized === "crédito" || normalized === "credito" || normalized === "deposit") {
    return "credit";
  }

  if (normalized === "debit" || normalized === "débito" || normalized === "debito" || normalized === "withdrawal") {
    return "debit";
  }

  throw new Error(`Invalid transaction direction: ${value}`);
}
