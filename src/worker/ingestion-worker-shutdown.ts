import type { IngestionWorkerControl } from "./ingestion-worker-factory";

export type IngestionWorkerShutdownResult = Readonly<{ status: "graceful" | "forced" | "timed_out" | "failed"; exitCode: 0 | 1 }>;
type CloseHook = () => Promise<void> | void;
type StepResult = "ok" | "failed" | "timed_out";

export interface IngestionWorkerShutdownOptions {
  worker: IngestionWorkerControl;
  timeoutMs: number;
  hooks?: Readonly<{ stopExpiryScheduling?: CloseHook; closeLock?: CloseHook; closeExpiryOutbox?: CloseHook; closePrisma?: CloseHook }>;
}

export function createIngestionWorkerShutdown(options: IngestionWorkerShutdownOptions): () => Promise<IngestionWorkerShutdownResult> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("Shutdown timeout must be positive.");
  let shutdown: Promise<IngestionWorkerShutdownResult> | undefined;
  return () => shutdown ??= runShutdown(options);
}

async function runShutdown(options: IngestionWorkerShutdownOptions): Promise<IngestionWorkerShutdownResult> {
  let timedOut = false; let failed = false; let closeStarted = false;
  let expire!: () => void;
  const deadline = new Promise<void>((resolve) => { expire = () => { timedOut = true; resolve(); }; });
  const timer = setTimeout(expire, options.timeoutMs);
  const invoke = (step: CloseHook): Promise<void> => {
    const pending = Promise.resolve().then(step);
    void pending.catch(() => undefined);
    return pending;
  };
  const within = async (step: CloseHook): Promise<StepResult> => {
    const pending = invoke(step);
    if (timedOut) return "timed_out";
    return Promise.race([pending.then(() => "ok" as const, () => "failed" as const), deadline.then(() => "timed_out" as const)]);
  };
  const cleanup = async (hooks: readonly (CloseHook | undefined)[]) => {
    for (const hook of hooks) {
      if (!hook) continue;
      const result = await within(hook);
      if (result === "failed") failed = true;
    }
  };

  const paused = await within(options.worker.pauseIntake);
  options.worker.abortActive();
  if (paused !== "ok") failed ||= paused === "failed";
  const stopped = await within(options.hooks?.stopExpiryScheduling ?? (() => undefined));
  failed ||= stopped === "failed";
  if (paused === "ok" && stopped === "ok") {
    if (!timedOut) {
      const drained = await within(options.worker.awaitActiveDrain);
      failed ||= drained === "failed";
      if (!timedOut) {
        closeStarted = true;
        const closed = await within(options.worker.gracefulClose);
        failed ||= closed === "failed";
      }
    }
  }
  if (!closeStarted && (timedOut || failed || paused !== "ok" || stopped !== "ok")) {
    options.worker.abortActive();
    closeStarted = true;
    const forced = await within(options.worker.forceClose);
    failed ||= forced === "failed";
  }
  await cleanup([options.hooks?.closeLock, options.hooks?.closeExpiryOutbox, options.hooks?.closePrisma]);
  clearTimeout(timer);
  if (timedOut) return { status: "timed_out", exitCode: 1 };
  if (failed) return { status: closeStarted ? "failed" : "forced", exitCode: 1 };
  return { status: "graceful", exitCode: 0 };
}

export function installIngestionWorkerShutdown(options: Readonly<{ shutdown: () => Promise<IngestionWorkerShutdownResult>; terminate: (code: number) => void; signals: { on(signal: "SIGTERM" | "SIGINT", handler: () => void): unknown } }>): void {
  let handled: Promise<void> | undefined;
  const handle = () => handled ??= options.shutdown().then((result) => { if (result.exitCode !== 0) options.terminate(result.exitCode); });
  options.signals.on("SIGTERM", () => { void handle(); });
  options.signals.on("SIGINT", () => { void handle(); });
}
