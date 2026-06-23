import type { IngestionJob, IngestionResult } from "./queues";
import type { InMemoryScheduledIngestionQueue } from "../app/api/scrape-runs/defaults";

export type InMemoryIngestionProcessor = (job: IngestionJob) => Promise<IngestionResult>;

export type DrainResult = IngestionResult | { error: Error };

export interface InMemoryIngestionConsumer {
  drainPending(): Promise<DrainResult[]>;
}

export interface CreateInMemoryIngestionConsumerOptions {
  queue: InMemoryScheduledIngestionQueue;
  processor: InMemoryIngestionProcessor;
  /**
   * Recovery hook invoked when a DEQUEUED job's processor throws.
   *
   * The consumer removes a job from the in-memory queue before processing it,
   * so a processor throw that is NOT handled inside the processor itself
   * (e.g. `markRunning` failing before the processor's try/catch) would
   * otherwise leave the scrape run stuck in `queued` with no pending job —
   * an orphan. This hook lets the caller mark the run `failed` with a safe
   * summary, mirroring the queue-failure recovery in `run-now.ts`.
   *
   * The hook is awaited inside the drain loop but its own failures are
   * swallowed so recovery can never mask the original processor error.
   */
  onJobError?: (job: IngestionJob, error: Error) => Promise<void>;
}

/**
 * In-process consumer for the InMemoryScheduledIngestionQueue.
 *
 * Processes every job currently in the queue FIFO, removing each before
 * processing so the queue is empty when drainPending() resolves.  Errors in
 * one job are captured and returned as { error } entries — they never stop
 * the rest of the batch. When `onJobError` is provided, it is invoked for
 * each thrown job so the caller can mark the corresponding scrape run failed
 * and avoid orphaned `queued` runs.
 *
 * This approach is intentional for the local/dev deployment target.  When
 * BullMQ + a separate worker process is introduced (PR5+), this consumer
 * will be retired and the queue will be replaced.
 */
export function createInMemoryIngestionConsumer(
  options: CreateInMemoryIngestionConsumerOptions,
): InMemoryIngestionConsumer {
  return {
    async drainPending(): Promise<DrainResult[]> {
      const results: DrainResult[] = [];

      // Drain by splicing one job at a time so errors on one job never
      // prevent the remaining jobs from being processed.
      while (options.queue.jobs.length > 0) {
        const [pending] = options.queue.jobs.splice(0, 1);

        try {
          const result = await options.processor({ data: pending.data });
          results.push(result);
        } catch (error) {
          const wrapped = error instanceof Error ? error : new Error(String(error));
          // Recovery: the job has already been removed from the in-memory
          // queue. If the processor threw before its own failure catch (for
          // example `markRunning` rejecting), the scrape run would otherwise
          // stay `queued` with no pending job. Give the caller a chance to
          // mark it failed. Recovery failures are swallowed so they never
          // mask the original processor error.
          if (options.onJobError) {
            try {
              await options.onJobError({ data: pending.data }, wrapped);
            } catch {
              // intentional: recovery must not mask the original error
            }
          }
          results.push({ error: wrapped });
        }
      }

      return results;
    },
  };
}
