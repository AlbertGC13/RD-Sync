import { spawn as nodeSpawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Browser runtime helper
//
// Ensures a CDP-enabled bank browser (Brave/Chromium) is running before the
// Popular scraper attaches. The helper is deliberately testable through
// injected deps (fetch, spawn, sleep, now) so unit tests never touch a real
// browser or process.
//
// SECURITY: the launch command is sourced from a trusted operator-managed env
// var (RD_SYNC_BANK_BROWSER_LAUNCH_COMMAND). It is acceptable for local server
// configuration but must never be set from untrusted input. Command stdout/
// stderr are never surfaced in the safe error summary returned to callers —
// those details stay in server-side logs only.
// ---------------------------------------------------------------------------

// Runtime guard: configured CDP endpoints must be origin-only http loopback
// URLs before any fetch, connect, or launch path uses them. URL.hostname
// returns the BRACKETED form "[::1]" for http://[::1]:port, so the bare "::1"
// is unreachable here — only the bracketed IPv6 loopback belongs in this set.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const SAFE_SUMMARY_MALFORMED_CDP_URL = "CDP endpoint URL is malformed";
export const SAFE_SUMMARY_NON_LOOPBACK_CDP = "CDP endpoint must be on loopback (127.0.0.1 / localhost / ::1)";
export const SAFE_SUMMARY_UNSUPPORTED_PROTOCOL = "CDP endpoint uses an unsupported protocol (only http allowed)";

const SAFE_CDP_ERROR_SUMMARIES = new Set([
  SAFE_SUMMARY_MALFORMED_CDP_URL,
  SAFE_SUMMARY_NON_LOOPBACK_CDP,
  SAFE_SUMMARY_UNSUPPORTED_PROTOCOL,
]);

/**
 * Shared default CDP endpoint — the SINGLE source of truth for the loopback
 * debug port used when no CDP URL is configured. The scraper (popular-cdp), the
 * session monitor (bank-sessions), and the shell launcher
 * (scripts/launch-bank-browser.sh) MUST all agree on this value so the launcher
 * and worker can never bind/attach mismatched ports. The shell launcher cannot
 * import TypeScript, so its fallback literal is comment-anchored to this
 * constant and a parity test enforces the port stays equal.
 */
export const DEFAULT_CDP_URL = "http://127.0.0.1:9222";

export function assertCdpLoopback(rawUrl: string): void {
  let parsed: URL;
  const trimmedUrl = rawUrl.trim();
  try {
    parsed = new URL(trimmedUrl);
  } catch {
    throw new Error(SAFE_SUMMARY_MALFORMED_CDP_URL);
  }

  if (parsed.protocol !== "http:") {
    throw new Error(SAFE_SUMMARY_UNSUPPORTED_PROTOCOL);
  }

  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(SAFE_SUMMARY_NON_LOOPBACK_CDP);
  }

  if (
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    trimmedUrl.slice(parsed.origin.length) !== ""
  ) {
    throw new Error(SAFE_SUMMARY_MALFORMED_CDP_URL);
  }
}

export function getSafeCdpErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return SAFE_CDP_ERROR_SUMMARIES.has(message)
    ? message
    : SAFE_SUMMARY_MALFORMED_CDP_URL;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal fetch shape — returns whether the HTTP response succeeded.
 * Narrowed so tests can inject a trivial stub without constructing a full
 * Response object.
 */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean }>;

/**
 * Spawns a detached process for the given trusted command string. Optional env
 * vars are injected without altering the shell command text.
 */
export type SpawnLike = (
  command: string,
  options?: { env?: Record<string, string> },
) => void;

export interface BrowserRuntimeDeps {
  fetch?: FetchLike;
  spawn?: SpawnLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type EnsureCdpBrowserResult =
  | { ok: true; launched: boolean }
  | { ok: false; launched: boolean; safeErrorSummary: string };

export interface EnsureCdpBrowserOptions {
  cdpUrl: string;
  /** Command to launch the browser when CDP is not already available. */
  launchCommand?: string;
  /** Extra environment passed to the launcher without shell interpolation. */
  launchEnv?: Record<string, string>;
  /** Max time to wait for CDP after launching. Default 30000 ms. */
  readyTimeoutMs?: number;
  /** Poll interval while waiting for CDP. Default 500 ms. */
  pollIntervalMs?: number;
  deps?: BrowserRuntimeDeps;
}

// ---------------------------------------------------------------------------
// Safe error summaries
//
// Fixed strings — NEVER interpolated with command paths, stdout, stderr, or
// shell details. These are the only texts that can reach user-facing surfaces.
// ---------------------------------------------------------------------------

const SAFE_SUMMARY_NOT_RUNNING = "Bank browser is not running";
const SAFE_SUMMARY_NOT_READY = "Bank browser did not become ready in time";

// ---------------------------------------------------------------------------
// Tunable defaults (Fix H — extracted as named constants so they have a single
// source of truth shared by ensureCdpBrowser and createEnsureBrowserFromEnv)
// ---------------------------------------------------------------------------

const DEFAULT_CHECK_TIMEOUT_MS = 2_000;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

// ---------------------------------------------------------------------------
// Default dependency implementations
// ---------------------------------------------------------------------------

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSpawn(
  command: string,
  options?: { env?: Record<string, string> },
): void {
  const child = nodeSpawn(command, {
    shell: true,
    detached: true,
    stdio: "ignore",
    ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
  });
  child.unref();
}

// ---------------------------------------------------------------------------
// isCdpAvailable
// ---------------------------------------------------------------------------

export interface IsCdpAvailableDeps {
  fetch?: FetchLike;
  /** Per-request timeout in ms. Default 2000. */
  timeoutMs?: number;
}

/**
 * Checks whether a CDP endpoint is alive by requesting /json/version.
 * Throws fixed validation errors for malformed/non-loopback/non-http
 * configured URLs; returns false only for network errors, timeouts, or non-2xx
 * responses after the URL passes validation.
 */
export async function isCdpAvailable(
  cdpUrl: string,
  deps?: IsCdpAvailableDeps,
): Promise<boolean> {
  assertCdpLoopback(cdpUrl);

  const doFetch = deps?.fetch ?? globalThis.fetch;
  const timeoutMs = deps?.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(new URL("/json/version", cdpUrl).toString(), {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// ensureCdpBrowser
//
// Process-level launch mutex (Fix A — R4 CRITICAL):
// Concurrent calls with the same cdpUrl share a single in-flight launch
// attempt so the same Node process never spawns the browser twice. The first
// call runs the full check/launch/poll flow; concurrent callers await and
// receive the same result. The entry is cleared on completion (success or
// failure) so a later call re-checks CDP from scratch (it may have gone down
// again). This complements the shell-level flock in launch-bank-browser.sh,
// which guards against concurrent launches across separate processes.
// ---------------------------------------------------------------------------

const inflightLaunches = new Map<string, Promise<EnsureCdpBrowserResult>>();

/**
 * Ensures a CDP-enabled browser is available before the scraper connects.
 *
 * - If CDP is already alive, returns ok without launching.
 * - If CDP is down and no launch command is configured, returns a safe failure
 *   (the caller should report needs_admin_action).
 * - If a launch command is configured, spawns it and polls CDP until it becomes
 *   available or the ready timeout expires.
 *
 * Concurrent calls for the same cdpUrl are coalesced: only the first call
 * performs the launch; the rest await and share its result.
 *
 * Command output is never included in the safe error summary.
 */
export async function ensureCdpBrowser(
  options: EnsureCdpBrowserOptions,
): Promise<EnsureCdpBrowserResult> {
  const { cdpUrl } = options;

  try {
    assertCdpLoopback(cdpUrl);
  } catch (error) {
    return {
      ok: false,
      launched: false,
      safeErrorSummary: getSafeCdpErrorSummary(error),
    };
  }

  // Coalesce concurrent launches for the same CDP endpoint. If a launch is
  // already in flight, await and return its result instead of spawning again.
  const existing = inflightLaunches.get(cdpUrl);
  if (existing) {
    return existing;
  }

  const promise = runEnsureCdpBrowser(options).finally(() => {
    inflightLaunches.delete(cdpUrl);
  });
  inflightLaunches.set(cdpUrl, promise);
  return promise;
}

async function runEnsureCdpBrowser(
  options: EnsureCdpBrowserOptions,
): Promise<EnsureCdpBrowserResult> {
  const {
    cdpUrl,
    launchCommand,
    launchEnv,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    deps = {},
  } = options;

  const doFetch = deps.fetch ?? globalThis.fetch;
  const doSpawn = deps.spawn ?? defaultSpawn;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;

  // Already available — no launch needed.
  if (await isCdpAvailable(cdpUrl, { fetch: doFetch })) {
    return { ok: true, launched: false };
  }

  // Not available and no launch command configured — safe failure.
  if (!launchCommand) {
    return { ok: false, launched: false, safeErrorSummary: SAFE_SUMMARY_NOT_RUNNING };
  }

  // Launch the browser. Spawn failures are caught and reported as a safe
  // summary — never leak the command or its output.
  try {
    doSpawn(launchCommand, launchEnv ? { env: launchEnv } : undefined);
  } catch {
    return { ok: false, launched: true, safeErrorSummary: SAFE_SUMMARY_NOT_RUNNING };
  }

  // Poll until CDP responds or the ready timeout expires.
  const deadline = now() + readyTimeoutMs;
  while (now() < deadline) {
    await sleep(pollIntervalMs);
    if (await isCdpAvailable(cdpUrl, { fetch: doFetch })) {
      return { ok: true, launched: true };
    }
  }

  return { ok: false, launched: true, safeErrorSummary: SAFE_SUMMARY_NOT_READY };
}

export interface BankBrowserEnv {
  cdpUrl: string;
}

function readNonBlankEnv(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key];
  return value === undefined || value === "" ? undefined : value;
}

const SAFE_BANK_CODE_PATTERN = /^[a-z0-9_]+$/;

function normalizeBankCode(bankCode: string): string {
  const normalized = bankCode.trim().toLowerCase();
  if (!SAFE_BANK_CODE_PATTERN.test(normalized)) {
    throw new Error("Invalid bank code for browser launcher");
  }
  return normalized;
}

export function resolveBankBrowserEnv(
  bankCode: string,
  env: Record<string, string | undefined> = process.env,
): BankBrowserEnv {
  const prefix = `RD_SYNC_BANK_${normalizeBankCode(bankCode).toUpperCase()}_`;
  return {
    cdpUrl: readNonBlankEnv(env, `${prefix}CDP_URL`) ?? readNonBlankEnv(env, "RD_SYNC_CDP_URL") ?? "",
  };
}

// ---------------------------------------------------------------------------
// createEnsureBrowserFromEnv — factory for the scraper seam
// ---------------------------------------------------------------------------

export type EnsureBrowserSeam = () => Promise<EnsureCdpBrowserResult>;

function parseOptionalMs(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/**
 * Builds an `ensureBrowser` seam from process env vars, or returns undefined
 * when auto-launch is disabled (the scraper then connects directly as before).
 *
 * Env vars:
 *   RD_SYNC_CDP_URL                            — CDP endpoint (required)
 *   RD_SYNC_BANK_BROWSER_AUTO_LAUNCH           — "enabled" to activate
 *   RD_SYNC_BANK_BROWSER_LAUNCH_COMMAND        — command to start the browser
 *   RD_SYNC_BANK_BROWSER_READY_TIMEOUT_MS      — ready timeout (default 30000)
 *   RD_SYNC_BANK_BROWSER_POLL_INTERVAL_MS      — poll interval (default 500)
 *
 * SECURITY: RD_SYNC_BANK_BROWSER_LAUNCH_COMMAND is trusted operator-managed
 * server configuration. Never set it from user-facing or untrusted input.
 */
export function createEnsureBrowserFromEnv(
  env: Record<string, string | undefined> = process.env,
): EnsureBrowserSeam | undefined {
  const cdpUrl = env.RD_SYNC_CDP_URL;
  if (env.RD_SYNC_BANK_BROWSER_AUTO_LAUNCH !== "enabled" || !cdpUrl) {
    return undefined;
  }

  const launchCommand = env.RD_SYNC_BANK_BROWSER_LAUNCH_COMMAND;
  const readyTimeoutMs = parseOptionalMs(
    env.RD_SYNC_BANK_BROWSER_READY_TIMEOUT_MS,
    DEFAULT_READY_TIMEOUT_MS,
  );
  const pollIntervalMs = parseOptionalMs(
    env.RD_SYNC_BANK_BROWSER_POLL_INTERVAL_MS,
    DEFAULT_POLL_INTERVAL_MS,
  );

  return () =>
    ensureCdpBrowser({
      cdpUrl,
      launchCommand,
      readyTimeoutMs,
      pollIntervalMs,
    });
}

/** Builds an `ensureBrowser` seam for one bank using bank-aware CDP env vars. */
export function createEnsureBrowserForBank(
  bankCode: string,
  env: Record<string, string | undefined> = process.env,
  deps?: BrowserRuntimeDeps,
): EnsureBrowserSeam | undefined {
  const normalizedBankCode = normalizeBankCode(bankCode);
  const bankEnv = resolveBankBrowserEnv(normalizedBankCode, env);
  if (env.RD_SYNC_BANK_BROWSER_AUTO_LAUNCH !== "enabled" || !bankEnv.cdpUrl) {
    return undefined;
  }

  const launchCommand = env.RD_SYNC_BANK_BROWSER_LAUNCH_COMMAND;
  const readyTimeoutMs = parseOptionalMs(
    env.RD_SYNC_BANK_BROWSER_READY_TIMEOUT_MS,
    DEFAULT_READY_TIMEOUT_MS,
  );
  const pollIntervalMs = parseOptionalMs(
    env.RD_SYNC_BANK_BROWSER_POLL_INTERVAL_MS,
    DEFAULT_POLL_INTERVAL_MS,
  );

  return () =>
    ensureCdpBrowser({
      cdpUrl: bankEnv.cdpUrl,
      launchCommand,
      launchEnv: launchCommand ? { BANK_CODE: normalizedBankCode } : undefined,
      readyTimeoutMs,
      pollIntervalMs,
      deps,
    });
}
