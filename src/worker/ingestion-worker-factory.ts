/**
 * Testable factory for the BullMQ ingestion worker.
 *
 * Separates construction from the standalone entrypoint so unit tests can
 * inject a fake Worker constructor and fake processor — without a real Redis
 * connection.
 */

import { ingestionJobName, type IngestionJob, type IngestionResult } from "./queues/index";
import { expiryPublicationJobName } from "../modules/bank-sessions/expiry-publication";
import type { AuthenticatedIngestionDeliveryAttempt } from "./authenticated-ingestion-delivery";

export const INGESTION_QUEUE_NAME = ingestionJobName;

// ---------------------------------------------------------------------------
// Ports (structural interfaces so tests never import bullmq directly)
// ---------------------------------------------------------------------------

/** Minimal BullMQ Job surface the worker handler needs. */
export interface WorkerJob {
  name?: string;
  data: unknown;
  attemptsMade?: unknown;
  opts?: unknown;
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
  processor: (job: IngestionJob & Readonly<{ deliveryAttempt?: AuthenticatedIngestionDeliveryAttempt }>) => Promise<IngestionResult>;
  consumeRetiredExpiryPublicationJob?: (data: unknown) => Promise<unknown>;
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
 * - Calls `processor({ data: job.data, deliveryAttempt })` and RETURNS the result so BullMQ
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
        const deliveryAttempt = readDeliveryAttempt(job);
        if (deliveryAttempt === null) throw new Error("Invalid ingestion delivery attempt.");
        return options.processor({ data: job.data as IngestionJob["data"], deliveryAttempt });
      }
      if (job.name === expiryPublicationJobName && options.consumeRetiredExpiryPublicationJob) {
        return options.consumeRetiredExpiryPublicationJob(job.data);
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

function readDeliveryAttempt(job: WorkerJob): AuthenticatedIngestionDeliveryAttempt | null {
  try {
    const attemptsMade = Object.getOwnPropertyDescriptor(job, "attemptsMade");
    const options = Object.getOwnPropertyDescriptor(job, "opts");
    if (!attemptsMade || !attemptsMade.enumerable || !("value" in attemptsMade) || !options || !options.enumerable || !("value" in options) || options.value === null || typeof options.value !== "object" || Array.isArray(options.value)) return null;
    const attempts = Object.getOwnPropertyDescriptor(options.value, "attempts");
    const maxAttempts = attempts === undefined ? 1 : attempts.enumerable && "value" in attempts ? attempts.value : null;
    if (!Number.isSafeInteger(attemptsMade.value) || !Number.isSafeInteger(maxAttempts) || attemptsMade.value < 0 || maxAttempts <= 0 || attemptsMade.value >= maxAttempts) return null;
    return Object.freeze({ attemptsMade: attemptsMade.value, maxAttempts });
  } catch {
    return null;
  }
}
