import {
  AuthenticatedIngestionInvalidJobError,
  classifyAuthenticatedIngestionDeliveryJob,
  type AuthenticatedIngestionTerminalOutcome,
} from "./authenticated-ingestion-delivery";

export type AuthenticatedIngestionActivation = Readonly<{ status: "enabled" | "disabled" }>;

export function resolveAuthenticatedIngestionActivation(raw: string | undefined): AuthenticatedIngestionActivation {
  return Object.freeze(raw === "enabled" ? { status: "enabled" } : { status: "disabled" });
}

export type DisabledAuthenticatedIngestionProcessorDependencies<TResult> = Readonly<{
  complete: (outcome: AuthenticatedIngestionTerminalOutcome) => Promise<TResult>;
}>;

export function createDisabledAuthenticatedIngestionProcessor<TResult>(
  dependencies: DisabledAuthenticatedIngestionProcessorDependencies<TResult>,
): (job: Readonly<{ data: unknown; signal?: AbortSignal; deliveryAttempt?: unknown }>) => Promise<TResult> {
  return async (job) => {
    let envelope: Readonly<{ data: unknown; signal?: AbortSignal }> = { data: undefined };
    try {
      const data = Object.getOwnPropertyDescriptor(job, "data");
      const signal = Object.getOwnPropertyDescriptor(job, "signal");
      if (data?.enumerable && "value" in data && (signal === undefined || signal.enumerable && "value" in signal)) {
        envelope = signal === undefined ? { data: data.value } : { data: data.value, signal: signal.value as AbortSignal };
      }
    } catch {
      // Hostile envelopes are intentionally classified as invalid below.
    }
    const delivery = classifyAuthenticatedIngestionDeliveryJob(envelope);
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
