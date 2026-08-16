import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createIngestionWorker,
  INGESTION_QUEUE_NAME,
  type WorkerConstructor,
  type WorkerHandle,
  type WorkerJob,
} from "./ingestion-worker-factory";
import { expiryPublicationJobName } from "../modules/bank-sessions/expiry-publication";
import type { IngestionResult } from "./queues/index";

// ---------------------------------------------------------------------------
// Fake Worker
// ---------------------------------------------------------------------------

type JobHandler = (job: WorkerJob) => Promise<unknown>;

class FakeWorker implements WorkerHandle {
  readonly queueName: string;
  readonly handler: JobHandler;
  readonly options: { connection: unknown; concurrency: number };
  closed = false;

  constructor(
    queueName: string,
    handler: JobHandler,
    options: { connection: unknown; concurrency: number },
  ) {
    this.queueName = queueName;
    this.handler = handler;
    this.options = options;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function makeFakeWorkerCtor(): { Ctor: WorkerConstructor; instances: FakeWorker[] } {
  const instances: FakeWorker[] = [];

  class TrackingFakeWorker extends FakeWorker {
    constructor(
      queueName: string,
      handler: JobHandler,
      options: { connection: unknown; concurrency: number },
    ) {
      super(queueName, handler, options);
      instances.push(this);
    }
  }

  return { Ctor: TrackingFakeWorker as unknown as WorkerConstructor, instances };
}

// ---------------------------------------------------------------------------
// Fake processor
// ---------------------------------------------------------------------------

const successResult: IngestionResult = { status: "succeeded", inserted: 2, skipped: 1 };

function makeSuccessProcessor() {
  return vi.fn(async (): Promise<IngestionResult> => successResult);
}

const fakeConnection = {
  host: "localhost",
  port: 6379,
  maxRetriesPerRequest: null as null,
};

const fakeJob: WorkerJob = {
  name: INGESTION_QUEUE_NAME,
  data: { runId: "run-worker-1", bankId: "popular", accountFingerprint: "acct-main" },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createIngestionWorker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the ingestion queue name to the Worker constructor", () => {
    const { Ctor, instances } = makeFakeWorkerCtor();
    createIngestionWorker({ connection: fakeConnection, processor: makeSuccessProcessor(), WorkerCtor: Ctor });

    expect(instances).toHaveLength(1);
    expect(instances[0].queueName).toBe(INGESTION_QUEUE_NAME);
  });

  it("passes connection and concurrency options to the Worker constructor", () => {
    const { Ctor, instances } = makeFakeWorkerCtor();
    createIngestionWorker({
      connection: fakeConnection,
      processor: makeSuccessProcessor(),
      concurrency: 4,
      WorkerCtor: Ctor,
    });

    expect(instances[0].options.connection).toBe(fakeConnection);
    expect(instances[0].options.concurrency).toBe(4);
  });

  it("defaults concurrency to 2 when not specified", () => {
    const { Ctor, instances } = makeFakeWorkerCtor();
    createIngestionWorker({ connection: fakeConnection, processor: makeSuccessProcessor(), WorkerCtor: Ctor });

    expect(instances[0].options.concurrency).toBe(2);
  });

  it("the worker handler calls processor with job.data and returns the result", async () => {
    const { Ctor, instances } = makeFakeWorkerCtor();
    const processor = makeSuccessProcessor();
    createIngestionWorker({ connection: fakeConnection, processor, WorkerCtor: Ctor });

    const result = await instances[0].handler({ ...fakeJob, name: INGESTION_QUEUE_NAME });

    expect(processor).toHaveBeenCalledOnce();
    expect(processor).toHaveBeenCalledWith({ data: fakeJob.data });
    expect(result).toEqual(successResult);
  });

  it("routes only the exact expiry publication job name to the retired handler without invoking the processor", async () => {
    const { Ctor, instances } = makeFakeWorkerCtor();
    const consumeRetiredExpiryPublicationJob = vi.fn(async () => ({ status: "acknowledged" }));
    const processor = makeSuccessProcessor();
    createIngestionWorker({ connection: fakeConnection, processor, consumeRetiredExpiryPublicationJob, WorkerCtor: Ctor });

    const data = { arbitrary: { unknown: true } };
    await expect(instances[0].handler({ ...fakeJob, name: expiryPublicationJobName, data })).resolves.toEqual({ status: "acknowledged" });

    expect(consumeRetiredExpiryPublicationJob).toHaveBeenCalledWith(data);
    expect(processor).not.toHaveBeenCalled();
  });

  it("fails closed for unknown names and for expiry jobs without a consumer", async () => {
    const { Ctor, instances } = makeFakeWorkerCtor();
    createIngestionWorker({ connection: fakeConnection, processor: makeSuccessProcessor(), WorkerCtor: Ctor });

    await expect(instances[0].handler({ ...fakeJob, name: "unknown" })).rejects.toThrow("Unsupported BullMQ job name");
    await expect(instances[0].handler({ ...fakeJob, name: expiryPublicationJobName })).rejects.toThrow("Unsupported BullMQ job name");
  });

  it("composes the retired handler in production without the legacy claim consumer", async () => {
    const source = await readFile(new URL("./ingestion-worker.ts", import.meta.url), "utf8");

    expect(source).toContain("createRetiredExpiryPublicationConsumer");
    expect(source).toContain("auditSink: defaultAuditSink");
    expect(source).not.toContain("createExpiryPublicationConsumer");
  });

  it("the worker handler does NOT swallow an unexpected processor throw", async () => {
    const { Ctor, instances } = makeFakeWorkerCtor();
    const error = new Error("DB connection lost");
    const throwingProcessor = vi.fn(async () => {
      throw error;
    });

    createIngestionWorker({ connection: fakeConnection, processor: throwingProcessor, WorkerCtor: Ctor });

    await expect(instances[0].handler(fakeJob)).rejects.toThrow("DB connection lost");
  });

  it("terminal processor outcomes (needs_admin_action) are returned, not thrown", async () => {
    const { Ctor, instances } = makeFakeWorkerCtor();
    const terminalResult: IngestionResult = { status: "needs_admin_action", inserted: 0, skipped: 0 };
    const processor = vi.fn(async (): Promise<IngestionResult> => terminalResult);

    createIngestionWorker({ connection: fakeConnection, processor, WorkerCtor: Ctor });

    const result = await instances[0].handler(fakeJob);

    expect(result).toEqual(terminalResult);
  });

  it("terminal processor outcome (failed) is returned, not thrown", async () => {
    const { Ctor, instances } = makeFakeWorkerCtor();
    const failedResult: IngestionResult = { status: "failed", inserted: 0, skipped: 0 };
    const processor = vi.fn(async (): Promise<IngestionResult> => failedResult);

    createIngestionWorker({ connection: fakeConnection, processor, WorkerCtor: Ctor });

    const result = await instances[0].handler(fakeJob);

    expect(result).toEqual(failedResult);
  });

  it("worker.close() is called on graceful shutdown", async () => {
    const { Ctor, instances } = makeFakeWorkerCtor();
    const worker = createIngestionWorker({ connection: fakeConnection, processor: makeSuccessProcessor(), WorkerCtor: Ctor });

    expect(instances[0].closed).toBe(false);

    await worker.close();

    expect(instances[0].closed).toBe(true);
  });
});
