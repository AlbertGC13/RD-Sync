/**
 * Testable factory for the BullMQ ingestion worker.
 *
 * Separates construction from the standalone entrypoint so unit tests can
 * inject a fake Worker constructor and fake processor — without a real Redis
 * connection.
 */

import { ingestionJobName, type IngestionJob, type IngestionResult } from "./queues/index";
import { expiryPublicationJobName } from "../modules/bank-sessions/expiry-publication";

export const INGESTION_QUEUE_NAME = ingestionJobName;

// ---------------------------------------------------------------------------
// Ports (structural interfaces so tests never import bullmq directly)
// ---------------------------------------------------------------------------

/** Minimal BullMQ Job surface the worker handler needs. */
export interface WorkerJob {
  name?: string;
  data: IngestionJob["data"];
}

/** Minimal BullMQ Worker surface the factory returns. */
export interface WorkerHandle {
  close(): Promise<void>;
}

/** The constructor signature for a BullMQ Worker (or a test double). */
export type WorkerConstructor = new (
  queueName: string,
  handler: (job: WorkerJob) => Promise<unknown>,
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
  expiryPublicationConsumer?: (data: unknown) => Promise<unknown>;
  /** How many jobs to process in parallel.  Defaults to 2. */
  concurrency?: number;
  /**
   * The BullMQ Worker constructor.  The standalone entrypoint passes the real
   * `bullmq.Worker`; unit tests inject a fake.  Required on purpose: this keeps
   * the factory free of any bullmq import (ESM-safe, no require(), and bullmq
   * never leaks into a non-worker bundle).
   */
  WorkerCtor: WorkerConstructor;
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

  const WorkerCtor = options.WorkerCtor;

  const worker = new WorkerCtor(
    INGESTION_QUEUE_NAME,
    async (job: WorkerJob): Promise<unknown> => {
      if (job.name === INGESTION_QUEUE_NAME) {
        return options.processor({ data: job.data });
      }
      if (job.name === expiryPublicationJobName && options.expiryPublicationConsumer) {
        return options.expiryPublicationConsumer(job.data);
      }
      throw new Error("Unsupported BullMQ job name");
    },
    {
      connection: options.connection,
      concurrency,
    },
  );

  return worker;
}
