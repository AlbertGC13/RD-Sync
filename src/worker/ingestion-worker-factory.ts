/**
 * Testable factory for the BullMQ ingestion worker.
 *
 * Separates construction from the standalone entrypoint so unit tests can
 * inject a fake Worker constructor and fake processor — without a real Redis
 * connection.
 */

import type { IngestionJob, IngestionResult } from "./queues/index";

export const INGESTION_QUEUE_NAME = "bank-transaction-ingestion";

// ---------------------------------------------------------------------------
// Ports (structural interfaces so tests never import bullmq directly)
// ---------------------------------------------------------------------------

/** Minimal BullMQ Job surface the worker handler needs. */
export interface WorkerJob {
  data: IngestionJob["data"];
}

/** Minimal BullMQ Worker surface the factory returns. */
export interface WorkerHandle {
  close(): Promise<void>;
}

/** The constructor signature for a BullMQ Worker (or a test double). */
export type WorkerConstructor = new (
  queueName: string,
  handler: (job: WorkerJob) => Promise<IngestionResult>,
  options: { connection: unknown; concurrency: number },
) => WorkerHandle;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateIngestionWorkerOptions {
  /** ioredis connection options (host/port/password/maxRetriesPerRequest). */
  connection: { host: string; port: number; password?: string; maxRetriesPerRequest: null };
  /** Ingestion processor — called once per job. */
  processor: (job: IngestionJob) => Promise<IngestionResult>;
  /** How many jobs to process in parallel.  Defaults to 2. */
  concurrency?: number;
  /**
   * Override the BullMQ Worker constructor.  Inject a fake in unit tests.
   * When omitted, the real bullmq.Worker is used (production path).
   */
  WorkerCtor?: WorkerConstructor;
}

/**
 * Creates and starts a BullMQ worker that processes ingestion jobs.
 *
 * The handler:
 * - Calls `processor({ data: job.data })` and RETURNS the result so BullMQ
 *   marks the job completed.
 * - Does NOT swallow unexpected throws — BullMQ must see them to apply
 *   the retry/backoff configured in createIngestionQueueOptions.
 * - Terminal outcomes (needs_admin_action / failed) are handled inside the
 *   processor and returned normally; they do not propagate as errors here.
 */
export function createIngestionWorker(options: CreateIngestionWorkerOptions): WorkerHandle {
  const concurrency = options.concurrency ?? 2;

  const WorkerCtor: WorkerConstructor =
    options.WorkerCtor ??
    // Production: import bullmq.Worker synchronously (it is always installed).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require("bullmq") as { Worker: WorkerConstructor }).Worker;

  const worker = new WorkerCtor(
    INGESTION_QUEUE_NAME,
    async (job: WorkerJob): Promise<IngestionResult> => {
      // Unexpected throws propagate — BullMQ applies attempts/backoff.
      return options.processor({ data: job.data });
    },
    {
      connection: options.connection,
      concurrency,
    },
  );

  return worker;
}
