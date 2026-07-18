import { describe, expect, it, vi } from "vitest";

import {
  expiryPublicationJobName,
  observeExpiryPublicationJob,
  scheduleExpiryPublicationJob,
  type ExpiryPublicationEnvelope,
  type ExpiryPublicationQueue,
  type ExpiryPublicationRawState,
} from "./expiry-publication";

const episode = { bankCode: "popular", expiredEventId: "event", runId: "run" } as const;
const envelope = (): ExpiryPublicationEnvelope => ({ ...episode, token: "token-a" });

function createStoredJob(state: ExpiryPublicationRawState) {
  return { getState: vi.fn().mockResolvedValue(state) };
}

function createQueue(overrides: Partial<ExpiryPublicationQueue> = {}): ExpiryPublicationQueue {
  return {
    getJob: vi.fn().mockResolvedValue(undefined),
    add: vi.fn().mockResolvedValue(createStoredJob("waiting")),
    ...overrides,
  };
}

describe("scheduleExpiryPublicationJob", () => {
  it.each(["waiting", "active", "completed", "delayed", "prioritized", "waiting-children"] as const)(
    "returns the observed %s state for a pre-existing run without adding another job",
    async (state) => {
      const add = vi.fn();
      const queue = createQueue({ add, getJob: vi.fn().mockResolvedValue(createStoredJob(state)) });

      await expect(scheduleExpiryPublicationJob(queue, envelope())).resolves.toBe(state);
      expect(add).not.toHaveBeenCalled();
    },
  );

  it("adds an absent run with the bounded durable queue options and returns its observed state", async () => {
    const addedJob = createStoredJob("waiting");
    const add = vi.fn().mockResolvedValue(addedJob);
    const queue = createQueue({ add });

    await expect(scheduleExpiryPublicationJob(queue, envelope())).resolves.toBe("waiting");
    expect(add).toHaveBeenCalledWith(expiryPublicationJobName, envelope(), {
      jobId: episode.runId,
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 10 },
    });
    expect(queue.getJob).toHaveBeenCalledWith(episode.runId);
  });

  it("returns the observed state when add resolves during a duplicate race", async () => {
    const queue = createQueue({ add: vi.fn().mockResolvedValue(createStoredJob("active")) });

    await expect(scheduleExpiryPublicationJob(queue, envelope())).resolves.toBe("active");
  });

  it("recovers a thrown duplicate add by returning the recovered job state", async () => {
    const duplicateError = new Error("job already exists");
    const queue = createQueue({
      getJob: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue(createStoredJob("delayed")),
      add: vi.fn().mockRejectedValue(duplicateError),
    });

    await expect(scheduleExpiryPublicationJob(queue, envelope())).resolves.toBe("delayed");
    expect(queue.getJob).toHaveBeenCalledTimes(2);
  });

  it("reports a failed retained job as terminal without manually retrying it", async () => {
    const failedJob = createStoredJob("failed");
    const add = vi.fn();
    const queue = createQueue({ add, getJob: vi.fn().mockResolvedValue(failedJob) });

    await expect(scheduleExpiryPublicationJob(queue, envelope())).resolves.toBe("failed");
    expect(failedJob.getState).toHaveBeenCalledOnce();
    expect(add).not.toHaveBeenCalled();
  });

  it("rejects an unknown BullMQ state", async () => {
    const queue = createQueue({ getJob: vi.fn().mockResolvedValue(createStoredJob("unknown")) });

    await expect(scheduleExpiryPublicationJob(queue, envelope())).rejects.toThrow("Unsupported expiry publication job state: unknown");
  });

  it("rejects an unknown state returned by an add-resolved job", async () => {
    const queue = createQueue({ add: vi.fn().mockResolvedValue(createStoredJob("unknown")) });

    await expect(scheduleExpiryPublicationJob(queue, envelope())).rejects.toThrow("Unsupported expiry publication job state: unknown");
  });

  it("rethrows the original add error when no duplicate exists", async () => {
    const addError = new Error("queue unavailable");
    const queue = createQueue({ add: vi.fn().mockRejectedValue(addError) });

    await expect(scheduleExpiryPublicationJob(queue, envelope())).rejects.toBe(addError);
  });

  it("rethrows the original add error when duplicate recovery lookup fails", async () => {
    const addError = new Error("queue unavailable");
    const recoveryLookupError = new Error("Redis unavailable");
    const queue = createQueue({
      getJob: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(recoveryLookupError),
      add: vi.fn().mockRejectedValue(addError),
    });

    await expect(scheduleExpiryPublicationJob(queue, envelope())).rejects.toBe(addError);
  });

  it("rethrows the original add error when recovered-job state lookup fails", async () => {
    const addError = new Error("queue unavailable");
    const stateError = new Error("state unavailable");
    const recoveredJob = { getState: vi.fn().mockRejectedValue(stateError) };
    const queue = createQueue({
      getJob: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(recoveredJob),
      add: vi.fn().mockRejectedValue(addError),
    });

    await expect(scheduleExpiryPublicationJob(queue, envelope())).rejects.toBe(addError);
  });

  it("rethrows the original add error when recovered-job state is unknown", async () => {
    const addError = new Error("queue unavailable");
    const queue = createQueue({
      getJob: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(createStoredJob("unknown")),
      add: vi.fn().mockRejectedValue(addError),
    });

    await expect(scheduleExpiryPublicationJob(queue, envelope())).rejects.toBe(addError);
  });

  it("propagates the post-add observation rejection without attempting duplicate recovery", async () => {
    const observationError = new Error("state unavailable");
    const addedJob = { getState: vi.fn().mockRejectedValue(observationError) };
    const getJob = vi.fn().mockResolvedValue(undefined);
    const queue = createQueue({ getJob, add: vi.fn().mockResolvedValue(addedJob) });

    await expect(scheduleExpiryPublicationJob(queue, envelope())).rejects.toBe(observationError);
    expect(getJob).toHaveBeenCalledOnce();
  });
});

describe("observeExpiryPublicationJob", () => {
  it("reports missing when the retained run has been evicted", async () => {
    const queue = createQueue({ getJob: vi.fn().mockResolvedValue(undefined) });

    await expect(observeExpiryPublicationJob(queue, episode.runId)).resolves.toBe("missing");
  });

  it("rejects an unknown state during direct retained-job observation", async () => {
    const queue = createQueue({ getJob: vi.fn().mockResolvedValue(createStoredJob("unknown")) });

    await expect(observeExpiryPublicationJob(queue, episode.runId)).rejects.toThrow("Unsupported expiry publication job state: unknown");
  });
});
