import {
  resolveAuthenticatedIngestionActivation,
} from "../../../worker/authenticated-ingestion-activation-config";
import type { InMemoryIngestionConsumer } from "../../../worker/ingestion-consumer";

export const AUTHENTICATED_INGESTION_REDIS_REQUIRED = "Authenticated ingestion requires the separate Redis worker.";
export const IN_MEMORY_INGESTION_RUNTIME_UNAVAILABLE = "In-memory ingestion runtime is unavailable.";

type DisabledRuntime = Readonly<{
  createDefaultInMemoryIngestionConsumer: () => InMemoryIngestionConsumer | undefined;
}>;

export type IngestionConsumerSelectorDependencies = Readonly<{
  env?: Record<string, string | undefined>;
  loadDisabledRuntime?: () => Promise<DisabledRuntime>;
}>;

function hasConfiguredRedisUrl(value: string | undefined): boolean {
  return typeof value === "string" && /\S/.test(value);
}

export function createIngestionConsumerSelector(
  dependencies: IngestionConsumerSelectorDependencies = {},
): () => Promise<InMemoryIngestionConsumer | undefined> {
  const env = dependencies.env ?? process.env;
  const loadDisabledRuntime = dependencies.loadDisabledRuntime ?? (() => import("./consumer-defaults"));
  let runtime: DisabledRuntime | undefined;
  let consumer: InMemoryIngestionConsumer | undefined;
  let pending: Promise<DisabledRuntime> | undefined;
  let consumerPending: Promise<InMemoryIngestionConsumer> | undefined;

  const loadRuntime = () => {
    if (runtime) return Promise.resolve(runtime);
    pending ??= loadDisabledRuntime().then((loaded) => (runtime = loaded)).catch(() => {
      throw new Error(IN_MEMORY_INGESTION_RUNTIME_UNAVAILABLE);
    }).finally(() => { pending = undefined; });
    return pending;
  };

  return async () => {
    const activation = resolveAuthenticatedIngestionActivation(env.RD_SYNC_AUTHENTICATED_INGESTION);
    const redisConfigured = hasConfiguredRedisUrl(env.RD_SYNC_REDIS_URL);
    if (activation.status === "enabled") {
      if (!redisConfigured) throw new Error(AUTHENTICATED_INGESTION_REDIS_REQUIRED);
      await loadRuntime();
      return undefined;
    }
    if (redisConfigured) {
      await loadRuntime();
      return undefined;
    }
    if (consumer !== undefined) return consumer;
    consumerPending ??= loadRuntime().then((loaded) => {
      consumer = loaded.createDefaultInMemoryIngestionConsumer();
      if (!consumer) throw new Error(IN_MEMORY_INGESTION_RUNTIME_UNAVAILABLE);
      return consumer;
    }).finally(() => { consumerPending = undefined; });
    return consumerPending;
  };
}

const globalRegistry = globalThis as typeof globalThis & {
  __rdSyncDefaultIngestionConsumerSelector?: () => Promise<InMemoryIngestionConsumer | undefined>;
};

export const resolveDefaultIngestionConsumer =
  (globalRegistry.__rdSyncDefaultIngestionConsumerSelector ??= createIngestionConsumerSelector());
