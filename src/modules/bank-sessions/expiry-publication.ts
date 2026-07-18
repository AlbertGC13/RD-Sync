// ---------------------------------------------------------------------------
// BullMQ-backed scheduling port for durable expiry publication (B2.4).
//
// This mirrors the structural adapter pattern used by
// `src/worker/queues/bullmq-queue.ts`: a narrow port interface decouples the
// scheduling logic from the real BullMQ `Queue`, so unit tests inject a plain
// fake here while production wiring (PR4q) supplies the real BullMQ client.
//
// `getState()` returning `"unknown"` must reject rather than resolve, because
// an unrecognized BullMQ job state means the caller's scheduling-state
// contract cannot be honored safely — silently mapping it to a known state
// would hide a BullMQ version drift or an unexpected job lifecycle bug.
// ---------------------------------------------------------------------------
export type { ExpiryPublicationEnvelope } from "./expiry-episodes";
import type { ExpiryPublicationEnvelope } from "./expiry-episodes";

export type ExpiryPublicationSchedulingState = "waiting" | "active" | "completed" | "delayed" | "prioritized" | "waiting-children" | "failed";
export type ExpiryPublicationRawState = ExpiryPublicationSchedulingState | "unknown";

export interface ExpiryPublicationScheduledJob {
  getState(): Promise<ExpiryPublicationRawState>;
}

/** The subset of a BullMQ `Queue` that scheduling needs — kept structural so tests can fake it without importing BullMQ. */
export interface ExpiryPublicationQueue {
  add(
    name: string,
    data: ExpiryPublicationEnvelope,
    options: {
      jobId: string;
      attempts: number;
      backoff: { type: string; delay: number };
      removeOnComplete: { count: number };
      removeOnFail: { count: number };
    },
  ): Promise<ExpiryPublicationScheduledJob>;
  getJob(jobId: string): Promise<ExpiryPublicationScheduledJob | undefined>;
}

export const expiryPublicationJobName = "bank-session-expiry-publication";
export const expiryPublicationRetryOptions = Object.freeze({
  attempts: 3,
  backoff: Object.freeze({ type: "exponential", delay: 30_000 }),
  removeOnComplete: Object.freeze({ count: 100 }),
  removeOnFail: Object.freeze({ count: 10 }),
});

export async function scheduleExpiryPublicationJob(
  queue: ExpiryPublicationQueue,
  job: ExpiryPublicationEnvelope,
): Promise<ExpiryPublicationSchedulingState> {
  const existing = await queue.getJob(job.runId);
  if (existing) return observeScheduledJob(existing);

  try {
    const resolvedJob = await queue.add(expiryPublicationJobName, job, { jobId: job.runId, ...expiryPublicationRetryOptions });
    return observeScheduledJob(resolvedJob);
  } catch (addError) {
    try {
      const duplicate = await queue.getJob(job.runId);
      if (duplicate) return await observeScheduledJob(duplicate);
    } catch {
      // The original add error is more actionable than either a failed recovery
      // lookup or an unusable recovered-job state (rejected or "unknown"
      // observation) — both are swallowed here so the caller sees `addError`.
    }
    throw addError;
  }
}

export async function observeExpiryPublicationJob(
  queue: Pick<ExpiryPublicationQueue, "getJob">,
  runId: string,
): Promise<ExpiryPublicationSchedulingState | "missing"> {
  const retainedJob = await queue.getJob(runId);
  return retainedJob ? observeScheduledJob(retainedJob) : "missing";
}

async function observeScheduledJob(job: ExpiryPublicationScheduledJob): Promise<ExpiryPublicationSchedulingState> {
  const state = await job.getState();
  switch (state) {
    case "failed":
      return "failed";
    case "waiting":
    case "active":
    case "completed":
    case "delayed":
    case "prioritized":
    case "waiting-children":
      return state;
    case "unknown":
      throw new Error("Unsupported expiry publication job state: unknown");
  }
}
