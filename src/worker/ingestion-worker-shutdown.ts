import type { IngestionWorkerControl } from "./ingestion-worker-factory";

export type IngestionWorkerShutdownResult = Readonly<{ exitCode: 0 | 1; forced: boolean; failed: boolean }>;
type CloseHook = () => Promise<void> | void;

export interface IngestionWorkerShutdownOptions {
  worker: IngestionWorkerControl;
  timeoutMs: number;
  hooks?: Readonly<{
    stopExpiryScheduling?: CloseHook;
    closeLock?: CloseHook;
    closeExpiryOutbox?: CloseHook;
    closePrisma?: CloseHook;
  }>;
}

export function createIngestionWorkerShutdown(options: IngestionWorkerShutdownOptions): () => Promise<IngestionWorkerShutdownResult> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("Shutdown timeout must be positive.");
  let shutdown: Promise<IngestionWorkerShutdownResult> | undefined;
  return () => shutdown ??= runShutdown(options);
}

async function runShutdown(options: IngestionWorkerShutdownOptions): Promise<IngestionWorkerShutdownResult> {
  let forced = false;
  let failed = false;
  try { await options.worker.pauseIntake(); } catch { forced = true; failed = true; }
  options.worker.abortActive();
  try { await options.hooks?.stopExpiryScheduling?.(); } catch { failed = true; }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const drained = Promise.resolve().then(() => options.worker.awaitActiveDrain()).then(() => true, () => { failed = true; return false; });
  const settled = await Promise.race([
    drained,
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), options.timeoutMs); }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (!settled) forced = true;
  if (forced) options.worker.abortActive();
  try { await (forced ? options.worker.forceClose() : options.worker.gracefulClose()); } catch { failed = true; forced = true; }
  for (const hook of [options.hooks?.closeLock, options.hooks?.closeExpiryOutbox, options.hooks?.closePrisma]) {
    try { await hook?.(); } catch { failed = true; }
  }
  return { exitCode: forced || failed ? 1 : 0, forced, failed };
}
