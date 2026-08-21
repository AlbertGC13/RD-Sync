import type { IngestionJob, IngestionResult } from "./queues";
import type { InMemoryScheduledIngestionQueue } from "../app/api/scrape-runs/defaults";
import type { AuthenticatedIngestionDeliveryAttempt } from "./authenticated-ingestion-delivery";

export type InMemoryIngestionProcessor = (job: IngestionJob & Readonly<{
  deliveryAttempt?: AuthenticatedIngestionDeliveryAttempt;
}>) => Promise<IngestionResult>;

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

const DRAIN_ERROR_MESSAGE = "In-memory ingestion job failed.";
const QUEUE_OPTION_KEYS = ["attempts", "backoff", "jobId", "removeOnComplete", "removeOnFail"] as const;

function readMaxAttempts(job: unknown): number | null {
  try {
    if (job === null || typeof job !== "object") return null;
    const options = Object.getOwnPropertyDescriptor(job, "options");
    if (!options || !options.enumerable || !("value" in options)) return null;
    if (options.value === undefined) return 1;
    if (options.value === null || typeof options.value !== "object" || Array.isArray(options.value)) return null;
    const prototype = Object.getPrototypeOf(options.value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(options.value);
    if (keys.some((key) => typeof key !== "string" || !QUEUE_OPTION_KEYS.includes(key as typeof QUEUE_OPTION_KEYS[number]))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(options.value);
    if (keys.some((key) => {
      const descriptor = descriptors[key as string];
      return !descriptor || !descriptor.enumerable || !("value" in descriptor);
    })) return null;
    const attempts = descriptors.attempts;
    if (attempts === undefined) return 1;
    return Number.isSafeInteger(attempts.value) && attempts.value > 0 ? attempts.value : null;
  } catch {
    return null;
  }
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
        const maxAttempts = readMaxAttempts(pending);
        const fixedError = new Error(DRAIN_ERROR_MESSAGE);

        if (maxAttempts === null) {
          if (options.onJobError) {
            try {
              await options.onJobError({ data: pending.data }, fixedError);
            } catch {
              // Recovery failures are bounded and must not escape the drain.
            }
          }
          results.push({ error: fixedError });
          continue;
        }

        for (let attemptsMade = 0; attemptsMade < maxAttempts; attemptsMade += 1) {
          try {
            const result = await options.processor({
              data: pending.data,
              deliveryAttempt: Object.freeze({ attemptsMade, maxAttempts }),
            });
            results.push(result);
            break;
          } catch (error) {
            if (attemptsMade + 1 < maxAttempts) {
              // Both retryable delivery failures and unknown failures use the
              // stored queue retry budget; only the final failure terminalizes.
              continue;
            }
            if (options.onJobError) {
              try {
                await options.onJobError({ data: pending.data }, error instanceof Error ? error : fixedError);
              } catch {
                // Recovery failures are bounded and must not escape the drain.
              }
            }
            results.push({ error: fixedError });
          }
        }
      }

      return results;
    },
  };
}
