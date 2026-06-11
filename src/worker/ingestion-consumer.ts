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
}

/**
 * In-process consumer for the InMemoryScheduledIngestionQueue.
 *
 * Processes every job currently in the queue FIFO, removing each before
 * processing so the queue is empty when drainPending() resolves.  Errors in
 * one job are captured and returned as { error } entries — they never stop
 * the rest of the batch.
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
          results.push({ error: error instanceof Error ? error : new Error(String(error)) });
        }
      }

      return results;
    },
  };
}
