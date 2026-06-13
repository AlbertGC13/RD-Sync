import { createHash } from "node:crypto";

export type TransactionDirection = "credit" | "debit";
export type ReviewState = "new" | "seen" | "internally_validated" | "ignored" | "needs_review";

export interface BankMovement {
  bankId: string;
  accountFingerprint: string;
  postedAt: string | Date;
  amount: string | number;
  currency: string;
  direction: TransactionDirection;
  reference?: string | null;
  concept?: string | null;
  originator?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface TransactionRecord {
  id: string;
  bankId: string;
  accountFingerprint: string;
  postedAt: Date;
  amount: string;
  currency: string;
  direction: TransactionDirection;
  reference: string | null;
  concept: string | null;
  originator: string | null;
  reviewState: ReviewState;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  scrapeRunId: string | null;
  sourceHash: string;
  metadata: Record<string, unknown> | null;
}

export interface TransactionFilters {
  bankId?: string;
  accountFingerprint?: string;
  amount?: string | number;
  currency?: string;
  dateFrom?: string | Date;
  dateTo?: string | Date;
  query?: string;
  reviewState?: ReviewState;
}

export interface DashboardTransaction {
  id: string;
  bankId: string;
  accountFingerprint: string;
  postedAt: string;
  amount: string;
  currency: string;
  direction: TransactionDirection;
  reference: string | null;
  concept: string | null;
  originator: string | null;
  reviewState: ReviewState;
  reviewedAt: string | null;
}

export interface UpsertResult {
  inserted: number;
  skipped: number;
}

interface NormalizeOptions {
  id?: string;
  reviewState?: ReviewState;
  reviewedBy?: string | null;
  reviewedAt?: Date | null;
  scrapeRunId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export function normalizeBankMovement(movement: BankMovement, options: NormalizeOptions = {}): TransactionRecord {
  const identity = {
    bankId: normalizeText(movement.bankId) ?? "",
    accountFingerprint: normalizeText(movement.accountFingerprint) ?? "",
    postedAt: normalizeDate(movement.postedAt),
    amount: normalizeAmount(movement.amount),
    currency: normalizeText(movement.currency)?.toUpperCase() ?? "DOP",
    direction: movement.direction,
    reference: normalizeText(movement.reference),
    concept: normalizeText(movement.concept),
    originator: normalizeText(movement.originator),
  };

  // Derive the id from the source hash so two movements that differ only in
  // direction/reference/concept (e.g. a same-day credit and debit of equal
  // amount) get distinct ids. createSourceHash does not depend on id.
  const sourceHash = createSourceHash(identity);

  return {
    ...identity,
    id: options.id ?? createSyntheticId(sourceHash),
    reviewState: options.reviewState ?? "new",
    reviewedBy: options.reviewedBy ?? null,
    reviewedAt: options.reviewedAt ?? null,
    scrapeRunId: options.scrapeRunId ?? null,
    metadata: options.metadata ?? movement.metadata ?? null,
    sourceHash,
  };
}

export function createSourceHash(record: Pick<TransactionRecord, "bankId" | "accountFingerprint" | "postedAt" | "amount" | "currency" | "direction" | "reference" | "concept" | "originator">): string {
  const stableInput = [
    record.bankId,
    record.accountFingerprint,
    record.postedAt.toISOString(),
    normalizeAmount(record.amount),
    record.currency.toUpperCase(),
    record.direction,
    record.reference ?? "",
    record.concept ?? "",
    record.originator ?? "",
  ].join("|");

  return `sha256:${createHash("sha256").update(stableInput).digest("hex")}`;
}

export function filterTransactions(records: readonly TransactionRecord[], filters: TransactionFilters): TransactionRecord[] {
  const query = normalizeText(filters.query)?.toLowerCase();
  const amount = filters.amount === undefined ? undefined : normalizeAmount(filters.amount);
  const dateFrom = filters.dateFrom === undefined ? undefined : normalizeDate(filters.dateFrom);
  const dateTo = filters.dateTo === undefined ? undefined : normalizeDate(filters.dateTo);

  return records
    .filter((record) => {
      if (filters.bankId && record.bankId !== filters.bankId) return false;
      if (filters.accountFingerprint && record.accountFingerprint !== filters.accountFingerprint) return false;
      if (filters.currency && record.currency !== filters.currency.toUpperCase()) return false;
      if (filters.reviewState && record.reviewState !== filters.reviewState) return false;
      if (amount !== undefined && record.amount !== amount) return false;
      if (dateFrom && record.postedAt < dateFrom) return false;
      if (dateTo && record.postedAt > dateTo) return false;
      if (query && !transactionSearchText(record).includes(query)) return false;
      return true;
    })
    .sort((left, right) => right.postedAt.getTime() - left.postedAt.getTime());
}

export function toDashboardTransaction(record: TransactionRecord): DashboardTransaction {
  return {
    id: record.id,
    bankId: record.bankId,
    accountFingerprint: record.accountFingerprint,
    postedAt: record.postedAt.toISOString(),
    amount: record.amount,
    currency: record.currency,
    direction: record.direction,
    reference: record.reference,
    concept: record.concept,
    originator: record.originator,
    reviewState: record.reviewState,
    reviewedAt: record.reviewedAt?.toISOString() ?? null,
  };
}

export class InMemoryTransactionRepository {
  private readonly records = new Map<string, TransactionRecord>();

  async upsertMany(records: readonly TransactionRecord[]): Promise<UpsertResult> {
    let inserted = 0;
    let skipped = 0;

    for (const record of records) {
      if (this.records.has(record.sourceHash)) {
        skipped += 1;
        continue;
      }

      this.records.set(record.sourceHash, record);
      inserted += 1;
    }

    return { inserted, skipped };
  }

  async list(filters: TransactionFilters): Promise<TransactionRecord[]> {
    return filterTransactions([...this.records.values()], filters);
  }

  async updateReviewState(id: string, reviewState: ReviewState, reviewedBy: string, reviewedAt = new Date()): Promise<TransactionRecord | null> {
    const entry = [...this.records.entries()].find(([, record]) => record.id === id);
    if (!entry) return null;

    const [sourceHash, record] = entry;
    const updated: TransactionRecord = { ...record, reviewState, reviewedBy, reviewedAt };
    this.records.set(sourceHash, updated);
    return updated;
  }
}

function normalizeAmount(amount: string | number): string {
  const numeric = typeof amount === "number" ? amount : Number(amount.replace(/,/g, ""));
  if (!Number.isFinite(numeric)) {
    throw new Error(`Invalid transaction amount: ${amount}`);
  }

  return numeric.toFixed(2);
}

function normalizeDate(value: string | Date): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid transaction date: ${String(value)}`);
  }

  return date;
}

function normalizeText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function transactionSearchText(record: TransactionRecord): string {
  return [record.reference, record.concept, record.originator, record.amount]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function createSyntheticId(sourceHash: string): string {
  // sourceHash is "sha256:<hex>"; slice the hex for a stable short id that
  // inherits the full uniqueness of the source hash inputs.
  return sourceHash.replace(/^sha256:/, "").slice(0, 16);
}
