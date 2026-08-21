import type { PrismaClient } from "../generated/prisma/client";
import { BankAutoLoginConfigRepository } from "../modules/bank-auto-login-config/repository";
import { BankCredentialRepository } from "../modules/bank-credentials/repository";
import { createCredentialKeyResolver } from "../modules/bank-credentials/key-resolver";
import { createPrismaClient } from "../modules/persistence/prisma-client";
import { PrismaAuditSink } from "../modules/persistence/prisma-audit-sink";
import { PrismaBankSessionAuthenticationAttemptRepository } from "../modules/persistence/prisma-bank-session-authentication-attempt-repository";
import { PrismaScrapeRunRepository } from "../modules/persistence/prisma-scrape-run-repository";
import { PrismaTransactionRepository } from "../modules/persistence/prisma-transaction-repository";
import { createEmailAlertSink, createNodemailerTransport, type EmailTransport } from "./alerts/email-alert-sink";
import { createAuthenticatedIngestionRedisResource, type AuthenticatedIngestionRedisResource } from "./authenticated-ingestion-redis-resource";

type Repositories = Readonly<{
  authenticationAttempts: PrismaBankSessionAuthenticationAttemptRepository;
  autoLoginConfigs: BankAutoLoginConfigRepository;
  credentials: BankCredentialRepository;
  scrapeRuns: PrismaScrapeRunRepository;
  transactions: PrismaTransactionRepository;
  auditSink: PrismaAuditSink;
}>;
type PrismaWithDisconnect = Pick<PrismaClient, "$disconnect">;
type AlertSink = ReturnType<typeof createEmailAlertSink>;

export type AuthenticatedIngestionProductionResourceConfig = Readonly<{
  databaseUrl: string; redisUrl: string; redisLockTtlMs: number; redisLockRenewIntervalMs: number;
  credentialKey: string; smtpUrl: string; adminEmail: string;
}>;
export type AuthenticatedIngestionProductionResourceFactories = Readonly<{
  createPrismaClient(databaseUrl: string): PrismaWithDisconnect;
  createRedisResource(config: Readonly<{ redisUrl: string; ttlMs: number; renewIntervalMs: number }>): Promise<AuthenticatedIngestionRedisResource>;
  createRepositories(input: Readonly<{ prisma: PrismaClient }>): Repositories;
  createTransport(smtpUrl: string): EmailTransport;
  createAlertSink(input: Readonly<{ transport: EmailTransport; recipient: string }>): AlertSink;
}>;
export type AuthenticatedIngestionProductionResources = Readonly<Repositories & {
  restorationResolver: PrismaBankSessionAuthenticationAttemptRepository;
  credentialKeyResolver: (version?: number) => Buffer;
  bankAuthenticationLock: AuthenticatedIngestionRedisResource["lock"];
  alertSink: AlertSink;
  closeLock: AuthenticatedIngestionRedisResource["close"];
  closePrisma(): Promise<void>;
}>;

const INVALID_CONFIGURATION = "Invalid authenticated ingestion production resource configuration.";
const CONSTRUCTION_ERROR = "Unable to create authenticated ingestion production resources.";
const CLOSE_ERROR = "Unable to close authenticated ingestion production resources.";
const keys = ["databaseUrl", "redisUrl", "redisLockTtlMs", "redisLockRenewIntervalMs", "credentialKey", "smtpUrl", "adminEmail"] as const;

const defaults: AuthenticatedIngestionProductionResourceFactories = {
  createPrismaClient,
  createRedisResource: createAuthenticatedIngestionRedisResource,
  createRepositories: ({ prisma }) => Object.freeze({
    authenticationAttempts: new PrismaBankSessionAuthenticationAttemptRepository(prisma), autoLoginConfigs: new BankAutoLoginConfigRepository(prisma),
    credentials: new BankCredentialRepository(prisma), scrapeRuns: new PrismaScrapeRunRepository(prisma),
    transactions: new PrismaTransactionRepository(prisma), auditSink: new PrismaAuditSink(prisma),
  }),
  createTransport: createNodemailerTransport,
  createAlertSink: createEmailAlertSink,
};

function exact(value: unknown, expected: readonly string[]): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) || !Object.isFrozen(value)) return null;
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expected.length || ownKeys.some((key) => typeof key !== "string" || !expected.includes(key))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !("value" in descriptor))) return null;
    return Object.fromEntries(expected.map((key) => [key, descriptors[key]?.value]));
  } catch { return null; }
}

function validUrl(value: unknown, schemes: readonly string[]): value is string {
  if (typeof value !== "string" || !value || value !== value.trim() || /[\u0000-\u001F\u007F]/.test(value)) return false;
  try { const url = new URL(value); return schemes.includes(url.protocol) && url.hostname.length > 0 && !url.hash; } catch { return false; }
}

function parseConfig(value: unknown): AuthenticatedIngestionProductionResourceConfig | null {
  const config = exact(value, keys);
  if (!config || !validUrl(config.databaseUrl, ["postgres:", "postgresql:"]) || !validUrl(config.redisUrl, ["redis:", "rediss:"]) || !validUrl(config.smtpUrl, ["smtp:", "smtps:"])) return null;
  if (![config.redisLockTtlMs, config.redisLockRenewIntervalMs].every((value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0) || (config.redisLockRenewIntervalMs as number) >= (config.redisLockTtlMs as number)) return null;
  if (typeof config.adminEmail !== "string" || config.adminEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.adminEmail)) return null;
  try { createCredentialKeyResolver(config.credentialKey as string); } catch { return null; }
  return config as AuthenticatedIngestionProductionResourceConfig;
}

function resolveFactories(value: unknown): AuthenticatedIngestionProductionResourceFactories | null {
  try {
    if (value === undefined) return defaults;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const names = ["createPrismaClient", "createRedisResource", "createRepositories", "createTransport", "createAlertSink"] as const;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string" || !names.includes(key as typeof names[number]))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !("value" in descriptor))) return null;
    const resolved = Object.fromEntries(names.map((name) => [name, descriptors[name]?.value ?? defaults[name]]));
    return Object.values(resolved).every((factory) => typeof factory === "function") ? resolved as AuthenticatedIngestionProductionResourceFactories : null;
  } catch { return null; }
}

function hasMethods(value: unknown, methods: readonly string[]): boolean {
  try { return value !== null && typeof value === "object" && methods.every((method) => typeof (value as Record<string, unknown>)[method] === "function"); } catch { return false; }
}

function validRepositories(value: unknown): value is Repositories {
  const repositories = exact(value, ["authenticationAttempts", "autoLoginConfigs", "credentials", "scrapeRuns", "transactions", "auditSink"]);
  return !!repositories && hasMethods(repositories.authenticationAttempts, ["getOrCreate", "resolveObservedRestoration"]) && hasMethods(repositories.autoLoginConfigs, ["getByBankCode"]) && hasMethods(repositories.credentials, ["findAuthenticationMaterialByBankCode"]) && hasMethods(repositories.scrapeRuns, ["createQueued"]) && hasMethods(repositories.transactions, ["upsertMany"]) && hasMethods(repositories.auditSink, ["record"]);
}

async function cleanup(lock: AuthenticatedIngestionRedisResource | undefined, prisma: PrismaWithDisconnect | undefined): Promise<void> {
  try { await lock?.close(); } catch { /* preserve construction error */ }
  try { await prisma?.$disconnect(); } catch { /* preserve construction error */ }
}

export async function createAuthenticatedIngestionProductionResources(config: AuthenticatedIngestionProductionResourceConfig, overrides?: Partial<AuthenticatedIngestionProductionResourceFactories>): Promise<AuthenticatedIngestionProductionResources> {
  const parsed = parseConfig(config);
  if (!parsed) throw new Error(INVALID_CONFIGURATION);
  const factories = resolveFactories(overrides);
  if (!factories) throw new Error(CONSTRUCTION_ERROR);
  const credentialKeyResolver = createCredentialKeyResolver(parsed.credentialKey);
  let prisma: PrismaWithDisconnect | undefined;
  let redis: AuthenticatedIngestionRedisResource | undefined;
  try {
    prisma = factories.createPrismaClient(parsed.databaseUrl);
    if (!hasMethods(prisma, ["$disconnect"])) throw new Error();
    redis = await factories.createRedisResource(Object.freeze({ redisUrl: parsed.redisUrl, ttlMs: parsed.redisLockTtlMs, renewIntervalMs: parsed.redisLockRenewIntervalMs }));
    if (!redis || !hasMethods(redis.lock, ["acquire"]) || typeof redis.close !== "function") throw new Error();
    const repositories = factories.createRepositories({ prisma: prisma as PrismaClient });
    if (!validRepositories(repositories)) throw new Error();
    const transport = factories.createTransport(parsed.smtpUrl);
    if (!hasMethods(transport, ["send"])) throw new Error();
    const alertSink = factories.createAlertSink({ transport, recipient: parsed.adminEmail });
    if (!hasMethods(alertSink, ["notifyIngestionAttention", "notifySessionAttention"])) throw new Error();
    let closePromise: Promise<void> | undefined;
    const closePrisma = () => closePromise ??= Promise.resolve().then(() => prisma?.$disconnect()).then(() => undefined, () => { throw new Error(CLOSE_ERROR); });
    return Object.freeze({
      authenticationAttempts: repositories.authenticationAttempts, restorationResolver: repositories.authenticationAttempts,
      autoLoginConfigs: repositories.autoLoginConfigs, credentials: repositories.credentials, scrapeRuns: repositories.scrapeRuns,
      transactions: repositories.transactions, auditSink: repositories.auditSink, credentialKeyResolver,
      bankAuthenticationLock: redis.lock, alertSink, closeLock: redis.close, closePrisma,
    });
  } catch {
    await cleanup(redis, prisma);
    throw new Error(CONSTRUCTION_ERROR);
  }
}
