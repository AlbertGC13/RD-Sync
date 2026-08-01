import { LoginMutationGuard, LoginMutationGuardError, type BankPortalConfig, type LoginMutationPage } from "./login-mutation-guard";
import {
  assertCdpLoopback,
  connectPlaywrightOverCdp,
  getSafeCdpErrorSummary,
  openCdpPageInDefaultContext,
  type AcquireBrowserSlot,
  type CdpBrowserLike,
  type CdpPageLike,
  type EnsureCdpBrowserResult,
} from "./browser-runtime";
import { decryptCredentialField, type AesGcmEnvelope, type KeyResolver } from "../../modules/bank-credentials/crypto";
import type { AutoLoginLock } from "../../modules/bank-auto-login-lock";

export interface BankAutoLoginCredential {
  bankCode: string;
  username: string;
  password: string;
}

export interface BankAutoLoginPage extends LoginMutationPage {
  fill(selector: string, value: string): void | Promise<void>;
  click(selector: string): void | Promise<void>;
}

export type ScrapeTimeAutoLoginBrowserResult = { status: "ready"; page: BankAutoLoginPage; close(): Promise<void> } | { status: "throttled" };
export interface AutoLoginCdpPageLike extends CdpPageLike {
  waitForSelector(selector: string, options?: { timeout?: number; state?: string }): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
}
export type AutoLoginCdpBrowserLike = CdpBrowserLike<AutoLoginCdpPageLike>;
export interface ScrapeTimeAutoLoginBrowserOpenerOptions {
  /** Trusted adapter/factory configuration; never derived from the attached page. */
  trustedLoginUrl: string;
  connect?: (cdpUrl: string) => Promise<AutoLoginCdpBrowserLike>;
  ensureBrowserRuntime?: (cdpUrl: string) => Promise<EnsureCdpBrowserResult>;
  acquireBrowserSlot?: AcquireBrowserSlot;
  recordCleanupFailure?(metadata: { bankCode: string; failure: BrowserCleanupFailure }): void | Promise<void>;
  cleanupTimeoutMs?: number;
  pageSetupTimeoutMs?: number;
  visibleSelectorTimeoutMs?: number;
}
export type BankAutoLoginAdminActionReason =
  | "unsupported_bank"
  | "credential_bank_mismatch"
  | "auto_login_config_unavailable"
  | "credential_unavailable"
  | "incompatible_flow"
  | "protected_flow"
  | "missing_required_login_control"
  | "portal_state_unavailable"
  | "malformed_url"
  | "unauthorized_login_page"
  | "unknown_post_submit_state"
  | "browser_unavailable"
  | "auto_login_execution_failed";

export type BankAutoLoginOutcome =
  | { status: "succeeded" }
  | { status: "needs_admin_action"; reason: BankAutoLoginAdminActionReason; safeSummary: string };

export interface BankAutoLoginStrategy {
  readonly bankCode: string;
  autoLogin(context: { credential: BankAutoLoginCredential; page: BankAutoLoginPage }): Promise<BankAutoLoginOutcome>;
}

export type ScrapeTimeAutoLoginOutcome =
  | BankAutoLoginOutcome
  | { status: "manual_required"; reason: "lock_busy" | "lock_unavailable"; safeSummary: string }
  | { status: "skipped"; reason: "disabled" | "breaker_open" | "credential_unavailable"; safeSummary: string }
  | { status: "throttled"; safeSummary: string };

export interface ScrapeTimeAutoLoginTriggerContext {
  bankCode: string;
  expiredEventId: string;
  runId?: string;
  adapter: { readonly bankCode: string; createAutoLoginStrategy(): BankAutoLoginStrategy };
  credential: BankAutoLoginCredential;
  cdpUrl: string;
  lock: Pick<AutoLoginLock, "acquire" | "release">;
  ensureBrowser(cdpUrl: string): Promise<ScrapeTimeAutoLoginBrowserResult>;
  recordLockReleaseFailure?(metadata: { bankCode: string; expiredEventId: string }): void | Promise<void>;
  beforeAutoLoginMutation?(metadata: AutoLoginMutationHookMetadata): boolean | Promise<boolean>;
  afterAutoLoginOutcome?(metadata: AutoLoginOutcomeHookMetadata): void | Promise<void>;
}

export interface AutoLoginMutationHookMetadata {
  bankCode: string;
  expiredEventId: string;
}

export interface AutoLoginOutcomeHookMetadata extends AutoLoginMutationHookMetadata {
  runId?: string;
  outcome: ScrapeTimeAutoLoginOutcome;
}

export interface ScrapeTimeAutoLoginRunnerJob {
  data: {
    bankId: string; // Canonical bank code from IngestionJobData, not a database id.
    expiredEventId?: string;
    runId?: string;
  };
}

export interface ScrapeTimeAutoLoginCredentialRecord {
  bankCode: string;
  isActive: boolean;
  keyVersion: number;
  encryptedUsernameEnvelope: string;
  encryptedPasswordEnvelope: string;
}

export interface ScrapeTimeAutoLoginConfigRecord {
  autoLoginEnabled: boolean;
  breakerState: "closed" | "open";
}

export interface ScrapeTimeAutoLoginRunnerDependencies {
  adapterRegistry: {
    get(bankCode: string): { readonly bankCode: string; createAutoLoginStrategy(): BankAutoLoginStrategy } | undefined;
  };
  autoLoginConfigs: {
    getByBankCode(bankCode: string): Promise<ScrapeTimeAutoLoginConfigRecord | null>;
  };
  credentials: {
    findByBankCode(bankCode: string): Promise<ScrapeTimeAutoLoginCredentialRecord | null>;
  };
  keyResolver: KeyResolver;
  lock: Pick<AutoLoginLock, "acquire" | "release"> | null;
  cdpUrlForBankCode(bankCode: string): string | undefined;
  ensureBrowser(bankCode: string, cdpUrl: string): Promise<ScrapeTimeAutoLoginBrowserResult>;
  recordLockReleaseFailure?(metadata: { bankCode: string; expiredEventId: string }): void | Promise<void>;
  recordCredentialDecryptUse?(metadata: { bankCode: string; keyVersion: number }): void | Promise<void>;
  recordFailure?(bankCode: string, occurredAt: Date): void | Promise<void>;
  beforeAutoLoginMutation?(metadata: AutoLoginMutationHookMetadata): boolean | Promise<boolean>;
  afterAutoLoginOutcome?(metadata: AutoLoginOutcomeHookMetadata): void | Promise<void>;
}

const SAFE_ADMIN_ACTION_SUMMARY = "Bank auto-login requires admin action";
const SAFE_BROWSER_THROTTLED_SUMMARY = "Bank browser capacity is temporarily unavailable";
const SAFE_MANUAL_REQUIRED_SUMMARY = "Manual scrape required before retrying bank auto-login";

type CredentialResolution =
  | { status: "found"; credential: BankAutoLoginCredential }
  | { status: "not_found" }
  | Extract<BankAutoLoginOutcome, { status: "needs_admin_action" }>;

type RunnerAdapter = ReturnType<ScrapeTimeAutoLoginRunnerDependencies["adapterRegistry"]["get"]>;

export const unavailableScrapeTimeAutoLoginBrowserOpener: ScrapeTimeAutoLoginRunnerDependencies["ensureBrowser"] = async () => {
  throw new Error("Scrape-time auto-login browser page opener is not wired yet");
};

export const DEFAULT_VISIBLE_SELECTOR_TIMEOUT_MS = 10_000;
const MIN_VISIBLE_SELECTOR_TIMEOUT_MS = 1_000;
const MAX_VISIBLE_SELECTOR_TIMEOUT_MS = 30_000;
const DEFAULT_BROWSER_CLEANUP_TIMEOUT_MS = 1_000;
const DEFAULT_BROWSER_PAGE_SETUP_TIMEOUT_MS = 15_000;
const PAGE_SETUP_TIMEOUT_ERROR = "Timed out while preparing the trusted bank login page";
type BrowserCleanupFailure = "browser_slot_release_failed" | "page_close_failed" | "browser_close_failed";

export function createScrapeTimeAutoLoginBrowserOpener(options: ScrapeTimeAutoLoginBrowserOpenerOptions): ScrapeTimeAutoLoginRunnerDependencies["ensureBrowser"] {
  const {
    trustedLoginUrl,
    connect = connectPlaywrightOverCdp<AutoLoginCdpBrowserLike>,
    ensureBrowserRuntime,
    acquireBrowserSlot, recordCleanupFailure,
    cleanupTimeoutMs = DEFAULT_BROWSER_CLEANUP_TIMEOUT_MS,
    pageSetupTimeoutMs = DEFAULT_BROWSER_PAGE_SETUP_TIMEOUT_MS,
    visibleSelectorTimeoutMs = parseAutoLoginSelectorTimeoutMs(process.env.RD_SYNC_AUTOLOGIN_SELECTOR_TIMEOUT_MS),
  } = options;
  return async (bankCode, cdpUrl) => {
    assertCdpLoopback(cdpUrl);
    const browserSlot = await acquireBrowserSlot?.();
    if (browserSlot?.kind === "throttled") return { status: "throttled" };
    const acquiredBrowserSlot = browserSlot?.kind === "acquired" ? browserSlot : null;
    let browser: AutoLoginCdpBrowserLike | null = null;
    let page: AutoLoginCdpPageLike | null = null;
    let closeOwnedResources: Promise<void> | undefined;
    const closeResources = () => {
      closeOwnedResources ??= closeAutoLoginBrowserResources({ bankCode, page, browser,
        browserSlot: acquiredBrowserSlot, recordCleanupFailure, cleanupTimeoutMs });
      return closeOwnedResources;
    };
    try {
      const browserCheck = await ensureBrowserRuntime?.(cdpUrl);
      if (browserCheck && !browserCheck.ok) throw new Error(browserCheck.safeErrorSummary);
      browser = await connect(cdpUrl);
      page = await openTrustedLoginPage({
        browser,
        trustedLoginUrl,
        timeoutMs: pageSetupTimeoutMs,
        cleanupTimeoutMs,
        onPageCloseFailure: () => recordBrowserCleanupFailure(recordCleanupFailure, bankCode, "page_close_failed"),
      });

      return { status: "ready", page: new CdpBankAutoLoginPage(page, visibleSelectorTimeoutMs), close: closeResources };
    } catch (error) {
      await closeResources();
      throw error;
    }
  };
}

/** Fractions truncate toward zero, matching parseScrapeLookbackDays. */
export function parseAutoLoginSelectorTimeoutMs(value: string | undefined): number {
  const normalized = value?.trim();
  if (!normalized) return DEFAULT_VISIBLE_SELECTOR_TIMEOUT_MS;

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return DEFAULT_VISIBLE_SELECTOR_TIMEOUT_MS;

  return Math.min(
    MAX_VISIBLE_SELECTOR_TIMEOUT_MS,
    Math.max(MIN_VISIBLE_SELECTOR_TIMEOUT_MS, Math.trunc(parsed)),
  );
}
type OpenTrustedLoginPageOptions = { browser: AutoLoginCdpBrowserLike; trustedLoginUrl: string; timeoutMs: number; cleanupTimeoutMs: number; onPageCloseFailure(): Promise<void> };

async function openTrustedLoginPage(options: OpenTrustedLoginPageOptions): Promise<AutoLoginCdpPageLike> {
  const { browser, trustedLoginUrl, timeoutMs, cleanupTimeoutMs, onPageCloseFailure } = options;
  let setupPage: AutoLoginCdpPageLike | null = null;
  let setupOwnsPage = true;
  let pageCleanup: Promise<void> | undefined;
  let setupAbandoned = false;
  const closeSetupPage = (): Promise<void> => {
    if (!setupPage || !setupOwnsPage) return Promise.resolve();
    pageCleanup ??= runBoundedCleanup(() => setupPage!.close(), cleanupTimeoutMs, onPageCloseFailure);
    return pageCleanup;
  };
  const setup = openCdpPageInDefaultContext(browser).then(async (page) => {
    setupPage = page;
    if (setupAbandoned) {
      await closeSetupPage();
      throw new Error(PAGE_SETUP_TIMEOUT_ERROR);
    }
    try {
      await page.goto(trustedLoginUrl);
    } catch (error) {
      await closeSetupPage();
      throw error;
    }
    if (setupAbandoned) {
      await closeSetupPage();
      throw new Error(PAGE_SETUP_TIMEOUT_ERROR);
    }
    setupOwnsPage = false;
    return page;
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      setup,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          setupAbandoned = true;
          reject(new Error(PAGE_SETUP_TIMEOUT_ERROR));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    setupAbandoned = true;
    void closeSetupPage();
    void setup.catch(() => undefined);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
class CdpBankAutoLoginPage implements BankAutoLoginPage {
  /**
   * Advisory only: the guard clamps this to its own safety floor, so a lowered
   * `RD_SYNC_AUTOLOGIN_SELECTOR_TIMEOUT_MS` can speed up form-visibility waits
   * without narrowing the protected-state detection window.
   */
  readonly protectedStateDetectionWindowMs: number;

  constructor(private readonly page: AutoLoginCdpPageLike, private readonly visibleSelectorTimeoutMs: number) {
    this.protectedStateDetectionWindowMs = visibleSelectorTimeoutMs;
  }

  async currentUrl(): Promise<string> { return this.page.url(); }
  async fill(selector: string, value: string): Promise<void> { await this.page.fill(selector, value); }
  async click(selector: string): Promise<void> { await this.page.click(selector); }
  async hasVisibleSelector(selector: string, timeoutMs?: number): Promise<boolean> {
    // `timeoutMs` lets the guard probe for states expected to be ABSENT without
    // paying the full visibility wait; omitted, it keeps the long default used
    // when waiting for the login form to render.
    const timeout = timeoutMs ?? this.visibleSelectorTimeoutMs;
    try {
      await this.page.waitForSelector(selector, { timeout, state: "visible" });
      return true;
    } catch (error) {
      if (isExpectedSelectorTimeout(error)) return false;
      throw error;
    }
  }
}
async function closeAutoLoginBrowserResources(options: {
  bankCode: string;
  page: AutoLoginCdpPageLike | null;
  browser: AutoLoginCdpBrowserLike | null;
  browserSlot: { release(): Promise<void> } | null;
  recordCleanupFailure?: ScrapeTimeAutoLoginBrowserOpenerOptions["recordCleanupFailure"];
  cleanupTimeoutMs: number;
}): Promise<void> {
  const { bankCode, page, browser, browserSlot, recordCleanupFailure, cleanupTimeoutMs } = options;
  // Free capacity before bounded CDP teardown; Popular owns its separate scraper lifecycle.
  if (browserSlot) await runBoundedCleanup(() => browserSlot.release(), cleanupTimeoutMs, () =>
    recordBrowserCleanupFailure(recordCleanupFailure, bankCode, "browser_slot_release_failed"));
  if (page) await runBoundedCleanup(() => page.close(), cleanupTimeoutMs, () =>
    recordBrowserCleanupFailure(recordCleanupFailure, bankCode, "page_close_failed"));
  if (browser) await runBoundedCleanup(() => browser.close(), cleanupTimeoutMs, () =>
    recordBrowserCleanupFailure(recordCleanupFailure, bankCode, "browser_close_failed"));
}

async function runBoundedCleanup(cleanup: () => Promise<void>, timeoutMs: number, onFailure: () => Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const cleanupResult = Promise.resolve().then(cleanup).then(() => "completed" as const, () => "failed" as const);
  const timeoutResult = new Promise<"timed_out">((resolve) => { timeout = setTimeout(() => resolve("timed_out"), timeoutMs); });
  const result = await Promise.race([cleanupResult, timeoutResult]);
  if (timeout) clearTimeout(timeout);
  if (result !== "completed") void Promise.resolve().then(onFailure).catch(() => undefined);
}
function isExpectedSelectorTimeout(error: unknown): boolean { return error instanceof Error && error.name === "TimeoutError"; }

async function recordBrowserCleanupFailure(
  recordCleanupFailure: ScrapeTimeAutoLoginBrowserOpenerOptions["recordCleanupFailure"] | undefined,
  bankCode: string,
  failure: BrowserCleanupFailure,
): Promise<void> {
  return Promise.resolve(recordCleanupFailure?.({ bankCode, failure })).then(() => undefined);
}
export function createScrapeTimeAutoLoginRunner(deps: ScrapeTimeAutoLoginRunnerDependencies) {
  return async function runScrapeTimeAutoLogin(job: ScrapeTimeAutoLoginRunnerJob): Promise<ScrapeTimeAutoLoginOutcome | null> {
    const expiredEventId = job.data.expiredEventId;
    if (!expiredEventId) return null;

    const outcome = await resolveScrapeTimeAutoLoginOutcome(deps, job, expiredEventId);
    if (outcome.status === "needs_admin_action" && outcome.reason === "unknown_post_submit_state") {
      try {
        await deps.recordFailure?.(job.data.bankId, new Date());
      } catch {
        // Breaker persistence must not replace the protected-flow outcome.
      }
    }
    try {
      await deps.afterAutoLoginOutcome?.({
        bankCode: job.data.bankId,
        expiredEventId,
        runId: job.data.runId,
        outcome,
      });
    } catch {
      // Outcome observability must not replace the protected-flow outcome.
    }
    return outcome;
  };
}

async function resolveScrapeTimeAutoLoginOutcome(
  deps: ScrapeTimeAutoLoginRunnerDependencies,
  job: ScrapeTimeAutoLoginRunnerJob,
  expiredEventId: string,
): Promise<ScrapeTimeAutoLoginOutcome> {
    const bankCode = job.data.bankId;
    const adapter = safelyResolveAdapter(deps, bankCode);
    if (isAdminActionOutcome(adapter)) return adapter;
    if (!adapter) return needsAdminAction("unsupported_bank");

    const config = await safelyResolveConfig(deps, bankCode);
    if (isAdminActionOutcome(config)) return config;
    if (!config?.autoLoginEnabled) return skipped("disabled");
    if (config.breakerState === "open") return skipped("breaker_open");

    if (!deps.lock) return manualRequired("lock_unavailable");

    const cdpUrl = safelyResolveCdpUrl(deps, bankCode);
    if (isAdminActionOutcome(cdpUrl)) return cdpUrl;
    if (!cdpUrl) return needsAdminAction("browser_unavailable");

    const credentialResolution = await resolveAutoLoginCredential(deps, bankCode);
    if (credentialResolution.status === "not_found") return skipped("credential_unavailable");
    if (isAdminActionOutcome(credentialResolution)) return credentialResolution;

    return executeScrapeTimeAutoLoginTrigger({
      bankCode,
      expiredEventId,
      adapter,
      credential: credentialResolution.credential,
      cdpUrl,
      lock: deps.lock,
      ensureBrowser: (url) => deps.ensureBrowser(bankCode, url),
      recordLockReleaseFailure: deps.recordLockReleaseFailure,
      beforeAutoLoginMutation: deps.beforeAutoLoginMutation,
    });
}

function safelyResolveAdapter(
  deps: Pick<ScrapeTimeAutoLoginRunnerDependencies, "adapterRegistry">,
  bankCode: string,
): RunnerAdapter | Extract<BankAutoLoginOutcome, { status: "needs_admin_action" }> {
  try {
    return deps.adapterRegistry.get(bankCode);
  } catch {
    return needsAdminAction("auto_login_config_unavailable");
  }
}

async function safelyResolveConfig(
  deps: Pick<ScrapeTimeAutoLoginRunnerDependencies, "autoLoginConfigs">,
  bankCode: string,
): Promise<ScrapeTimeAutoLoginConfigRecord | null | Extract<BankAutoLoginOutcome, { status: "needs_admin_action" }>> {
  try {
    return await deps.autoLoginConfigs.getByBankCode(bankCode);
  } catch {
    return needsAdminAction("auto_login_config_unavailable");
  }
}

function safelyResolveCdpUrl(
  deps: Pick<ScrapeTimeAutoLoginRunnerDependencies, "cdpUrlForBankCode">,
  bankCode: string,
): string | undefined | Extract<BankAutoLoginOutcome, { status: "needs_admin_action" }> {
  try {
    return deps.cdpUrlForBankCode(bankCode);
  } catch {
    return needsAdminAction("browser_unavailable");
  }
}

async function resolveAutoLoginCredential(
  deps: Pick<ScrapeTimeAutoLoginRunnerDependencies, "credentials" | "keyResolver" | "recordCredentialDecryptUse">,
  bankCode: string,
): Promise<CredentialResolution> {
  let record: ScrapeTimeAutoLoginCredentialRecord | null;
  try {
    record = await deps.credentials.findByBankCode(bankCode);
  } catch {
    return needsAdminAction("credential_unavailable");
  }
  if (!record?.isActive) return { status: "not_found" };
  if (record.bankCode !== bankCode) return needsAdminAction("credential_bank_mismatch");

  try {
    const credential = {
      bankCode,
      username: decryptCredentialField(parseCredentialEnvelope(record.encryptedUsernameEnvelope), deps.keyResolver),
      password: decryptCredentialField(parseCredentialEnvelope(record.encryptedPasswordEnvelope), deps.keyResolver),
    };
    await recordCredentialDecryptUse(deps, { bankCode, keyVersion: record.keyVersion });
    return { status: "found", credential };
  } catch {
    return needsAdminAction("credential_unavailable");
  }
}

async function recordCredentialDecryptUse(
  deps: Pick<ScrapeTimeAutoLoginRunnerDependencies, "recordCredentialDecryptUse">,
  metadata: { bankCode: string; keyVersion: number },
): Promise<void> {
  try {
    await deps.recordCredentialDecryptUse?.(metadata);
  } catch {
    // Audit/metrics failures must not leak or change scrape-time auto-login safety.
  }
}

function parseCredentialEnvelope(json: string): AesGcmEnvelope {
  const parsed = JSON.parse(json) as Partial<AesGcmEnvelope> | null;
  if (!parsed || typeof parsed.keyVersion !== "number" || typeof parsed.iv !== "string" || typeof parsed.ciphertext !== "string" || typeof parsed.tag !== "string") {
    throw new Error("Malformed credential envelope");
  }
  return parsed as AesGcmEnvelope;
}

export async function executeScrapeTimeAutoLoginTrigger(context: ScrapeTimeAutoLoginTriggerContext): Promise<ScrapeTimeAutoLoginOutcome> {
  if (context.adapter.bankCode !== context.bankCode) return needsAdminAction("unsupported_bank");
  if (context.adapter.bankCode !== context.credential.bankCode) return needsAdminAction("credential_bank_mismatch");

  const cdpUrl = context.cdpUrl;
  try {
    assertCdpLoopback(cdpUrl);
  } catch (error) {
    return needsAdminAction("browser_unavailable", getSafeCdpErrorSummary(error));
  }

  let acquired: Awaited<ReturnType<ScrapeTimeAutoLoginTriggerContext["lock"]["acquire"]>>;
  try {
    acquired = await context.lock.acquire(context.bankCode, context.expiredEventId);
  } catch {
    return manualRequired("lock_unavailable");
  }
  if (!acquired) return manualRequired("lock_busy");

  try {
    return await runOwnedAutoLogin(context, cdpUrl);
  } finally {
    await releaseOwnedLock(context, acquired.leaseToken);
  }
}

async function releaseOwnedLock(context: ScrapeTimeAutoLoginTriggerContext, leaseToken: string): Promise<void> {
  try {
    const released = await context.lock.release(context.bankCode, context.expiredEventId, leaseToken);
    if (!released) await recordLockReleaseFailure(context);
  } catch {
    // Lock TTL bounds eventual cleanup; do not let infrastructure details leak past the safe outcome.
    await recordLockReleaseFailure(context);
  }
}

async function recordLockReleaseFailure(context: ScrapeTimeAutoLoginTriggerContext): Promise<void> {
  try {
    await context.recordLockReleaseFailure?.({ bankCode: context.bankCode, expiredEventId: context.expiredEventId });
  } catch {
    // Observability failures must not change the safe auto-login outcome.
  }
}

async function runOwnedAutoLogin(context: ScrapeTimeAutoLoginTriggerContext, cdpUrl: string): Promise<ScrapeTimeAutoLoginOutcome> {
  let browser: ScrapeTimeAutoLoginBrowserResult | undefined;

  try {
    browser = await context.ensureBrowser(cdpUrl);
  } catch {
    return needsAdminAction("browser_unavailable");
  }

  if (browser?.status === "throttled") return { status: "throttled", safeSummary: SAFE_BROWSER_THROTTLED_SUMMARY };
  if (!browser) return needsAdminAction("browser_unavailable");

  let outcome: BankAutoLoginOutcome;
  try {
    outcome = await context.adapter.createAutoLoginStrategy().autoLogin({
      credential: context.credential,
      page: withAutoLoginMutationHook(browser.page, context),
    });
  } catch {
    outcome = needsAdminAction("portal_state_unavailable");
  } finally {
    try {
      await browser.close();
    } catch {
      // Cleanup failures must not change or leak past the safe auto-login outcome.
    }
  }

  try {
    await context.afterAutoLoginOutcome?.({
      bankCode: context.bankCode,
      expiredEventId: context.expiredEventId,
      ...(context.runId ? { runId: context.runId } : {}),
      outcome,
    });
  } catch {
    // Outcome observability must not replace the protected-flow outcome.
  }
  return outcome;
}

function withAutoLoginMutationHook(page: BankAutoLoginPage, context: ScrapeTimeAutoLoginTriggerContext): BankAutoLoginPage {
  if (!context.beforeAutoLoginMutation) return page;
  let mutationAuthorized = false;
  return {
    currentUrl: () => page.currentUrl(),
    // Forward timeoutMs. Dropping it silently restores the long default and
    // undoes the caller's probe choice; TypeScript cannot catch that, because a
    // function declaring fewer parameters stays assignable.
    hasVisibleSelector: (selector, timeoutMs) => page.hasVisibleSelector(selector, timeoutMs),
    // Forward the declared detection window too. Dropping it is fail-safe (the
    // guard falls back to its floor) but would silently discard an operator's
    // deliberately widened window.
    protectedStateDetectionWindowMs: page.protectedStateDetectionWindowMs,
    async fill(selector, value) {
      if (!mutationAuthorized) {
        const permitted = await context.beforeAutoLoginMutation?.({ bankCode: context.bankCode, expiredEventId: context.expiredEventId });
        if (permitted === false) throw new Error("Auto-login mutation was not authorized");
        mutationAuthorized = true;
      }
      await page.fill(selector, value);
    },
    click: (selector) => page.click(selector),
  };
}

function manualRequired(reason: "lock_busy" | "lock_unavailable"): ScrapeTimeAutoLoginOutcome {
  return { status: "manual_required", reason, safeSummary: SAFE_MANUAL_REQUIRED_SUMMARY };
}

function skipped(reason: "disabled" | "breaker_open" | "credential_unavailable"): ScrapeTimeAutoLoginOutcome {
  return { status: "skipped", reason, safeSummary: SAFE_MANUAL_REQUIRED_SUMMARY };
}

export function createBankAutoLoginStrategy(
  portalConfig: BankPortalConfig,
  options: { supportedBankCodes?: readonly string[] } = {},
): BankAutoLoginStrategy {
  const bankCode = portalConfig.bankCode ?? "";
  const supportedBankCodes = new Set(options.supportedBankCodes ?? [bankCode]);

  return {
    bankCode,
    async autoLogin({ credential, page }) {
      if (!bankCode || !supportedBankCodes.has(bankCode)) return needsAdminAction("unsupported_bank");
      if (credential.bankCode !== bankCode) return needsAdminAction("credential_bank_mismatch");
      if (!hasNonBlankString(portalConfig.dashboardPathIndicator)) return needsAdminAction("portal_state_unavailable");

      const guardResult = createGuard(portalConfig);
      if (guardResult.outcome) return guardResult.outcome;
      const { guard } = guardResult;

      // Every mutation boundary gets the same full detection window. Shortening
      // the two fill guards was measurably faster, but it let credentials reach
      // the DOM before a late overlay was seen, and `fill` raises browser events
      // the portal's own scripts may react to — so "nothing is transmitted yet"
      // was never a property this code could guarantee. The window stays whole.
      //
      // The window closes the gap between guard passes, not the gap between a
      // pass and the fill that follows it. An overlay landing in that instant is
      // still caught by the NEXT boundary, but by then a value is in the page,
      // so aborts after a fill scrub the inputs (see scrubCredentialFields).
      const beforeUsernameFill = await runGuard(() => guard.assertMutationAuthorized(page));
      if (beforeUsernameFill) return beforeUsernameFill;
      const usernameFill = await runBrowserMutation(() => page.fill(portalConfig.usernameSelector, credential.username));
      // Not scrubbed, and not because the DOM is known to be clean: a fill can
      // write a value and then fail on navigation, detach, or a later event, so
      // whether the username landed is undeterminable from here. The reason is
      // narrower — a failure here may mean the mutation hook denied
      // authorization, and scrubbing would re-enter that operator callback. The
      // password is only ever filled after this call succeeds, so the secret
      // stays covered below; a possibly-partial username is the accepted cost.
      if (usernameFill) return usernameFill;

      const beforePasswordFill = await runGuard(() => guard.assertMutationAuthorized(page));
      if (beforePasswordFill) return scrubCredentialFields(page, portalConfig, beforePasswordFill);
      const passwordFill = await runBrowserMutation(() => page.fill(portalConfig.passwordSelector, credential.password));
      if (passwordFill) return scrubCredentialFields(page, portalConfig, passwordFill);

      const beforeSubmit = await runGuard(() => guard.assertMutationAuthorized(page));
      if (beforeSubmit) return scrubCredentialFields(page, portalConfig, beforeSubmit);

      const submit = await runBrowserMutation(() => page.click(portalConfig.submitSelector));
      if (submit) return scrubCredentialFields(page, portalConfig, submit);
      return detectPostSubmitOutcome(page, portalConfig, guard);
    },
  };
}

/**
 * Best-effort clearing of the credential inputs when the flow aborts after a
 * successful fill.
 *
 * This does not undo a fill and does not pretend to: the portal's scripts may
 * already have read the values or reacted to the events, and nothing here can
 * reach into that. What it bounds is the residual exposure of leaving a
 * password sitting in a DOM the operator may drive by hand during manual
 * recovery.
 *
 * Failures are swallowed on purpose. The abort outcome is what the caller must
 * act on, and letting a cleanup error replace it would hide the real reason the
 * flow stopped. Only called once a fill has succeeded, so the mutation hook has
 * already authorized and is not re-entered.
 *
 * Each clear is bounded by its own deadline. Swallowing rejections is not
 * enough to make cleanup non-blocking: a `fill` that never settles would hold
 * the abort outcome forever, and with it the browser close and the lock
 * release — a secondary cleanup taking the primary path hostage. The deadline
 * is per field rather than shared so a hung password clear cannot also cost the
 * username its turn.
 */
export const CREDENTIAL_SCRUB_TIMEOUT_MS = 1_000;

async function scrubCredentialFields(
  page: BankAutoLoginPage,
  portalConfig: BankPortalConfig,
  outcome: BankAutoLoginOutcome,
): Promise<BankAutoLoginOutcome> {
  for (const selector of [portalConfig.passwordSelector, portalConfig.usernameSelector]) {
    await runBoundedCleanup(
      async () => { await page.fill(selector, ""); },
      CREDENTIAL_SCRUB_TIMEOUT_MS,
      async () => undefined,
    );
  }
  return outcome;
}

type GuardResult = { guard: LoginMutationGuard; outcome?: never } | { guard?: never; outcome: BankAutoLoginOutcome };

function createGuard(portalConfig: BankPortalConfig): GuardResult {
  try {
    return { guard: new LoginMutationGuard(portalConfig) };
  } catch (error) {
    if (error instanceof LoginMutationGuardError) return { outcome: needsAdminAction(error.reason, error.safeSummary) };
    return { outcome: needsAdminAction("portal_state_unavailable") };
  }
}

async function detectPostSubmitOutcome(
  page: BankAutoLoginPage,
  config: BankPortalConfig,
  guard: LoginMutationGuard,
): Promise<BankAutoLoginOutcome> {
  const guardedState = await runGuard(() => guard.assertNoProtectedOrIncompatibleState(page));
  if (guardedState) return guardedState;

  try {
    const baseUrl = new URL(config.baseUrl);
    const currentUrl = new URL(await page.currentUrl());
    if (
      baseUrl.protocol === "https:" &&
      currentUrl.protocol === "https:" &&
      currentUrl.origin === baseUrl.origin &&
      !hasUserInfo(baseUrl) &&
      !hasUserInfo(currentUrl) &&
      config.dashboardPathIndicator &&
      hasDashboardPathBoundary(currentUrl.pathname, config.dashboardPathIndicator)
    ) {
      const finalGuardedState = await runGuard(() => guard.assertNoProtectedOrIncompatibleState(page));
      if (finalGuardedState) return finalGuardedState;
      return { status: "succeeded" };
    }
  } catch {
    return needsAdminAction("portal_state_unavailable");
  }

  return needsAdminAction("unknown_post_submit_state");
}

async function runBrowserMutation(operation: () => void | Promise<void>): Promise<BankAutoLoginOutcome | null> {
  try {
    await operation();
    return null;
  } catch {
    return needsAdminAction("portal_state_unavailable");
  }
}

async function runGuard(operation: () => Promise<void>): Promise<BankAutoLoginOutcome | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    if (error instanceof LoginMutationGuardError) {
      return needsAdminAction(error.reason, error.safeSummary);
    }
    return needsAdminAction("portal_state_unavailable");
  }
}

function needsAdminAction(reason: BankAutoLoginAdminActionReason, safeSummary = SAFE_ADMIN_ACTION_SUMMARY): Extract<BankAutoLoginOutcome, { status: "needs_admin_action" }> {
  return { status: "needs_admin_action", reason, safeSummary };
}

function isAdminActionOutcome(value: unknown): value is Extract<BankAutoLoginOutcome, { status: "needs_admin_action" }> {
  return typeof value === "object" && value !== null && "status" in value && value.status === "needs_admin_action";
}

function hasNonBlankString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function hasDashboardPathBoundary(pathname: string, dashboardPathIndicator: string): boolean { return pathname === dashboardPathIndicator || pathname.startsWith(`${dashboardPathIndicator}/`); }
function hasUserInfo(url: URL): boolean { return url.username.length > 0 || url.password.length > 0; }
