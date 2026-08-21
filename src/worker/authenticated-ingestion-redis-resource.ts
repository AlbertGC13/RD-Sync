import Redis from "ioredis";
import { MAX_LOCK_TTL_MS, type LockStore } from "../modules/bank-auto-login-lock";
import { createRenewableBankAuthenticationLock, type RenewableBankAuthenticationLock } from "../modules/bank-auto-login-lock/renewable-bank-authentication-lock";
import { RedisLockStore, type RedisEvalClient } from "../modules/bank-auto-login-lock/redis-store";

type RedisClient = RedisEvalClient & Readonly<{ status: string; quit(): Promise<unknown>; disconnect(): void | Promise<void> }>;
type RedisOptions = Readonly<{ lazyConnect: true; maxRetriesPerRequest: 3; connectTimeout: 5000; commandTimeout: 5000 }>;
export type AuthenticatedIngestionRedisResourceConfig = Readonly<{ redisUrl: string; ttlMs: number; renewIntervalMs: number }>;
export type AuthenticatedIngestionRedisResource = Readonly<{ lock: RenewableBankAuthenticationLock; close(): Promise<void> }>;
export type AuthenticatedIngestionRedisResourceFactories = Readonly<{
  createClient(redisUrl: string, options: RedisOptions): RedisClient;
  createStore(input: Readonly<{ client: RedisEvalClient }>): LockStore;
  createLock(input: Readonly<{ store: LockStore; ttlMs: number; renewIntervalMs: number }>): RenewableBankAuthenticationLock;
}>;

const CLIENT_OPTIONS: RedisOptions = Object.freeze({ lazyConnect: true, maxRetriesPerRequest: 3, connectTimeout: 5000, commandTimeout: 5000 });
const INVALID_CONFIGURATION = "Invalid authenticated ingestion Redis resource configuration.";
const CONSTRUCTION_ERROR = "Unable to create authenticated ingestion Redis resource.";
const CLOSE_ERROR = "Unable to close authenticated ingestion Redis resource.";
const TERMINAL_STATUSES = new Set(["wait", "end", "close"]);

const defaults: AuthenticatedIngestionRedisResourceFactories = {
  createClient: (redisUrl, options) => new Redis(redisUrl, options),
  createStore: ({ client }) => new RedisLockStore({ client }),
  createLock: ({ store, ttlMs, renewIntervalMs }) => createRenewableBankAuthenticationLock({ store, ttlMs, renewIntervalMs }),
};

function parseConfig(value: unknown): AuthenticatedIngestionRedisResourceConfig | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) || !Object.isFrozen(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value);
    if ((prototype !== Object.prototype && prototype !== null) || keys.length !== 3 || keys.some((key) => typeof key !== "string" || !["redisUrl", "ttlMs", "renewIntervalMs"].includes(key))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !("value" in descriptor))) return null;
    const { redisUrl, ttlMs, renewIntervalMs } = descriptors as Record<string, PropertyDescriptor>;
    if (typeof redisUrl.value !== "string" || !validRedisUrl(redisUrl.value) || !positiveInteger(ttlMs.value) || !positiveInteger(renewIntervalMs.value) || ttlMs.value > MAX_LOCK_TTL_MS || renewIntervalMs.value >= ttlMs.value) return null;
    return Object.freeze({ redisUrl: redisUrl.value, ttlMs: ttlMs.value, renewIntervalMs: renewIntervalMs.value });
  } catch {
    return null;
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validRedisUrl(redisUrl: string): boolean {
  if (!redisUrl || redisUrl !== redisUrl.trim() || /[\u0000-\u001F\u007F]/.test(redisUrl)) return false;
  try {
    const parsed = new URL(redisUrl);
    return (parsed.protocol === "redis:" || parsed.protocol === "rediss:") && parsed.hostname.length > 0 && parsed.hash.length === 0;
  } catch {
    return false;
  }
}

async function disconnect(client: RedisClient): Promise<boolean> {
  try {
    await client.disconnect();
    return true;
  } catch {
    return false;
  }
}

async function closeClient(client: RedisClient): Promise<void> {
  let status: string;
  try {
    status = client.status;
  } catch {
    if (await disconnect(client)) return;
    throw new Error(CLOSE_ERROR);
  }
  // A lazy or terminal client must never be connected merely to close it.
  if (TERMINAL_STATUSES.has(status)) {
    if (await disconnect(client)) return;
    throw new Error(CLOSE_ERROR);
  }
  try {
    await client.quit();
  } catch {
    if (await disconnect(client)) return;
    throw new Error(CLOSE_ERROR);
  }
}

export async function createAuthenticatedIngestionRedisResource(
  config: AuthenticatedIngestionRedisResourceConfig,
  overrides: Partial<AuthenticatedIngestionRedisResourceFactories> = {},
): Promise<AuthenticatedIngestionRedisResource> {
  const parsed = parseConfig(config);
  if (!parsed) throw new Error(INVALID_CONFIGURATION);
  const factories = { ...defaults, ...overrides };
  let client: RedisClient | undefined;
  try {
    client = factories.createClient(parsed.redisUrl, CLIENT_OPTIONS);
    const store = factories.createStore({ client });
    const lock = factories.createLock({ store, ttlMs: parsed.ttlMs, renewIntervalMs: parsed.renewIntervalMs });
    let closePromise: Promise<void> | undefined;
    const close = () => closePromise ??= closeClient(client!);
    return Object.freeze({ lock, close });
  } catch {
    if (client) await disconnect(client);
    throw new Error(CONSTRUCTION_ERROR);
  }
}
