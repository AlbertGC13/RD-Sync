import { resolveAuthenticatedIngestionActivation } from "./authenticated-ingestion-activation-config";

export type AuthenticatedIngestionProductionConfig = Readonly<{
  databaseUrl: string;
  redisUrl: string;
  redisLockTtlMs: number;
  redisLockRenewIntervalMs: number;
  credentialKey: string;
  smtpUrl: string;
  adminEmail: string;
}>;

type ProductionModule<TResource, TProcessor> = Readonly<{
  createResources(config: AuthenticatedIngestionProductionConfig): Promise<TResource>;
  createProcessor(resources: TResource): TProcessor;
}>;

export type AuthenticatedIngestionProductionActivation<TProcessor> =
  | Readonly<{ kind: "legacy"; processor: TProcessor }>
  | Readonly<{ kind: "authenticated"; processor: TProcessor; closeLock: () => Promise<void>; closePrisma: () => Promise<void> }>;

export type AuthenticatedIngestionProductionActivationDependencies<TResource, TProcessor> = Readonly<{
  env: Record<string, string | undefined>;
  createLegacy(): TProcessor;
  loadProduction(): Promise<ProductionModule<TResource, TProcessor>>;
}>;

const ACTIVATION_ERROR = "Authenticated ingestion production activation failed.";
const positiveInteger = (value: string | undefined): number | null => {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

function readConfig(env: Record<string, string | undefined>): AuthenticatedIngestionProductionConfig | null {
  const databaseUrl = env.DATABASE_URL;
  const redisUrl = env.RD_SYNC_REDIS_URL;
  const credentialKey = env.RD_SYNC_BANK_CREDENTIAL_KEY;
  const smtpUrl = env.RD_SYNC_ALERT_SMTP_URL;
  const adminEmail = env.RD_SYNC_ADMIN_EMAIL;
  const redisLockTtlMs = positiveInteger(env.RD_SYNC_AUTHENTICATED_INGESTION_LOCK_TTL_MS);
  const redisLockRenewIntervalMs = positiveInteger(env.RD_SYNC_AUTHENTICATED_INGESTION_LOCK_RENEW_INTERVAL_MS);
  if (typeof databaseUrl !== "string" || !databaseUrl || typeof redisUrl !== "string" || !redisUrl || typeof credentialKey !== "string" || !credentialKey || typeof smtpUrl !== "string" || !smtpUrl || typeof adminEmail !== "string" || !adminEmail || redisLockTtlMs === null || redisLockRenewIntervalMs === null) return null;
  return Object.freeze({ databaseUrl, redisUrl, credentialKey, smtpUrl, adminEmail, redisLockTtlMs, redisLockRenewIntervalMs });
}

export async function activateAuthenticatedIngestionProduction<TResource extends Readonly<{ closeLock: () => Promise<void>; closePrisma: () => Promise<void> }>, TProcessor>(
  dependencies: AuthenticatedIngestionProductionActivationDependencies<TResource, TProcessor>,
): Promise<AuthenticatedIngestionProductionActivation<TProcessor>> {
  if (resolveAuthenticatedIngestionActivation(dependencies.env.RD_SYNC_AUTHENTICATED_INGESTION).status !== "enabled") {
    return Object.freeze({ kind: "legacy", processor: dependencies.createLegacy() });
  }
  const config = readConfig(dependencies.env);
  if (!config) throw new Error(ACTIVATION_ERROR);
  try {
    const production = await dependencies.loadProduction();
    const resources = await production.createResources(config);
    return Object.freeze({ kind: "authenticated", processor: production.createProcessor(resources), closeLock: resources.closeLock, closePrisma: resources.closePrisma });
  } catch {
    throw new Error(ACTIVATION_ERROR);
  }
}
