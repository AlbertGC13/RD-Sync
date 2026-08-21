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
    const delivery = classifyAuthenticatedIngestionDeliveryJob(job);
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
