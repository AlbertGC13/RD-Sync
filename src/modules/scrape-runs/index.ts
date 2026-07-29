import type {
  ScrapeRunRepository as WorkerScrapeRunRepository,
  ScrapeRunStatus,
} from "../../worker/queues";

export type { ScrapeRunStatus };

export interface ScrapeRunRecord {
  id: string;
  bankId: string;
  status: ScrapeRunStatus;
  startedAt: Date | null;
  endedAt: Date | null;
  insertedCount: number;
  skippedCount: number;
  safeErrorSummary: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScrapeRunFilters {
  bankId?: string;
  status?: ScrapeRunStatus;
  dateFrom?: string | Date;
  dateTo?: string | Date;
}

export interface DashboardScrapeRun {
  id: string;
  bankId: string;
  status: ScrapeRunStatus;
  startedAt: string | null;
  endedAt: string | null;
  insertedCount: number;
  skippedCount: number;
  safeErrorSummary: string | null;
}

export interface CreateQueuedScrapeRunInput {
  id: string;
  bankId: string;
  createdAt?: Date;
}

export function filterScrapeRuns(
  records: readonly ScrapeRunRecord[],
  filters: ScrapeRunFilters,
): ScrapeRunRecord[] {
  const dateFrom = filters.dateFrom === undefined ? undefined : normalizeDate(filters.dateFrom);
  const dateTo = filters.dateTo === undefined ? undefined : normalizeDate(filters.dateTo);

  return records
    .filter((record) => {
      if (filters.bankId && record.bankId !== filters.bankId) return false;
      if (filters.status && record.status !== filters.status) return false;
      if (dateFrom && record.createdAt < dateFrom) return false;
      if (dateTo && record.createdAt > dateTo) return false;
      return true;
    })
    .sort((left, right) => runActivityTime(right) - runActivityTime(left));
}

export function toDashboardScrapeRun(record: ScrapeRunRecord): DashboardScrapeRun {
  return {
    id: record.id,
    bankId: record.bankId,
    status: record.status,
    startedAt: record.startedAt?.toISOString() ?? null,
    endedAt: record.endedAt?.toISOString() ?? null,
    insertedCount: record.insertedCount,
    skippedCount: record.skippedCount,
    safeErrorSummary: record.safeErrorSummary,
  };
}

export class InMemoryScrapeRunRepository implements WorkerScrapeRunRepository {
  private readonly records = new Map<string, ScrapeRunRecord>();

  async createQueued(input: CreateQueuedScrapeRunInput): Promise<ScrapeRunRecord> {
    if (this.records.has(input.id)) {
      throw new Error(`Scrape run already exists: ${input.id}`);
    }

    const now = input.createdAt ?? new Date();
    const record: ScrapeRunRecord = {
      id: input.id,
      bankId: input.bankId,
      status: "queued",
      startedAt: null,
      endedAt: null,
      insertedCount: 0,
      skippedCount: 0,
      safeErrorSummary: null,
      createdAt: now,
      updatedAt: now,
    };

    this.records.set(record.id, record);
    return cloneScrapeRunRecord(record);
  }

  async list(filters: ScrapeRunFilters): Promise<ScrapeRunRecord[]> {
    return filterScrapeRuns([...this.records.values()], filters).map(cloneScrapeRunRecord);
  }

  /**
   * Read a single scrape run by id, or null when it does not exist.
   *
   * Used by the single-run status endpoint (GET /api/scrape-runs/[runId])
   * so the client can poll a run until it reaches a terminal state. This is
   * a direct map lookup rather than `list({})` + filter to avoid loading
   * every run into memory just to find one.
   *
   * Returns a defensive copy with cloned Date fields so callers cannot mutate
   * repository state — neither by reassigning a property nor by mutating a
   * Date object in place (`returned.createdAt.setTime(...)`).
   */
  async findById(runId: string): Promise<ScrapeRunRecord | null> {
    const record = this.records.get(runId);
    return record ? cloneScrapeRunRecord(record) : null;
  }

  async markRunning(runId: string, startedAt = new Date()): Promise<void> {
    this.update(runId, {
      status: "running",
      startedAt,
      endedAt: null,
      safeErrorSummary: null,
      updatedAt: startedAt,
    });
  }

  async markSucceeded(
    runId: string,
    counts: { insertedCount: number; skippedCount: number },
    endedAt = new Date(),
  ): Promise<void> {
    this.update(runId, {
      status: "succeeded",
      endedAt,
      insertedCount: counts.insertedCount,
      skippedCount: counts.skippedCount,
      safeErrorSummary: null,
      updatedAt: endedAt,
    });
  }

  async markNeedsAdminAction(
    runId: string,
    safeErrorSummary: string,
    endedAt = new Date(),
  ): Promise<void> {
    this.update(runId, {
      status: "needs_admin_action",
      endedAt,
      safeErrorSummary,
      updatedAt: endedAt,
    });
  }

  async markThrottled(runId: string, safeErrorSummary: string, endedAt = new Date()): Promise<void> {
    this.update(runId, {
      status: "throttled",
      endedAt,
      safeErrorSummary,
      updatedAt: endedAt,
    });
  }

  async markFailed(runId: string, safeErrorSummary: string, endedAt = new Date()): Promise<void> {
    this.update(runId, {
      status: "failed",
      endedAt,
      safeErrorSummary,
      updatedAt: endedAt,
    });
  }

  private update(runId: string, patch: Partial<ScrapeRunRecord>): void {
    const current = this.records.get(runId);
    if (!current) {
      throw new Error(`Scrape run not found: ${runId}`);
    }

    this.records.set(runId, { ...current, ...patch });
  }
}

function normalizeDate(value: string | Date): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid scrape run date: ${String(value)}`);
  }

  return date;
}

/**
 * Return a defensive copy of a scrape run record, cloning the Date fields so
 * callers cannot mutate repository state. A plain `{ ...record }` only
 * shallow-copies, which leaves the Date objects shared — mutating a returned
 * Date in place (`returned.createdAt.setTime(...)`) would leak into the stored
 * record. Reused by every read path (createQueued / list / findById).
 */
function cloneScrapeRunRecord(record: ScrapeRunRecord): ScrapeRunRecord {
  return {
    ...record,
    startedAt: record.startedAt ? new Date(record.startedAt) : null,
    endedAt: record.endedAt ? new Date(record.endedAt) : null,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

function runActivityTime(record: ScrapeRunRecord): number {
  return record.updatedAt.getTime();
}
