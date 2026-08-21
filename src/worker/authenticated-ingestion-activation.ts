import {
  AuthenticatedIngestionInvalidJobError,
  classifyAuthenticatedIngestionDeliveryJob,
  type AuthenticatedIngestionTerminalOutcome,
} from "./authenticated-ingestion-delivery";
export {
  resolveAuthenticatedIngestionActivation,
  type AuthenticatedIngestionActivation,
} from "./authenticated-ingestion-activation-config";

export type DisabledAuthenticatedIngestionProcessorDependencies<TResult> = Readonly<{
  complete: (outcome: AuthenticatedIngestionTerminalOutcome) => Promise<TResult>;
}>;

export function createDisabledAuthenticatedIngestionProcessor<TResult>(
  dependencies: DisabledAuthenticatedIngestionProcessorDependencies<TResult>,
): (job: Readonly<{ data: unknown; signal?: AbortSignal }>) => Promise<TResult> {
  return async (job) => {
    let delivery;
    try {
      const data = Object.getOwnPropertyDescriptor(job, "data");
      const signal = Object.getOwnPropertyDescriptor(job, "signal");
      if (!data?.enumerable || !("value" in data) || (signal !== undefined && (!signal.enumerable || !("value" in signal)))) throw new AuthenticatedIngestionInvalidJobError();
      delivery = classifyAuthenticatedIngestionDeliveryJob(signal === undefined ? { data: data.value } : { data: data.value, signal: signal.value as AbortSignal });
    } catch {
      throw new AuthenticatedIngestionInvalidJobError();
    }
    if (delivery.kind === "invalid") {
      if (delivery.runId === undefined) throw new AuthenticatedIngestionInvalidJobError();
      return dependencies.complete({ runId: delivery.runId, status: "failed", reason: "invalid_authenticated_ingestion_delivery" });
    }
    if (delivery.kind === "legacy") {
      return dependencies.complete({ runId: delivery.runId, bankId: delivery.bankId, status: "needs_admin_action", reason: "legacy_authenticated_ingestion_delivery" });
    }
    return dependencies.complete({ runId: delivery.runId, bankId: delivery.bankId, status: "needs_admin_action", reason: "authenticated_ingestion_disabled" });
  };
}
