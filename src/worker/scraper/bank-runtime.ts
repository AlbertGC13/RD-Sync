import { createCdpSessionChecker } from "../../modules/bank-sessions";
import { bhdPersonalBankCode } from "../../modules/bank-adapters/bhd";
import { popularBankCode } from "../../modules/bank-adapters/popular";
import { popularPortalConfig } from "../../modules/bank-adapters/popular-portal";
import { bhdPersonalPortalProfile } from "../../modules/bank-adapters/bhd";
import {
  createAcquireBrowserSlotFromEnv,
  createBankSessionBrowserConfig,
  type BrowserRuntimeDeps,
  type EnsureBrowserSession,
} from "./browser-runtime";
import type { ReadonlySessionChecker, SessionCheckerResolver } from "./authenticated-session-probe";
import {
  createScrapeTimeAutoLoginBrowserOpener,
  parseAutoLoginSelectorTimeoutMs,
  type ScrapeTimeAutoLoginBrowserOpenerOptions,
  type ScrapeTimeAutoLoginBrowserResult,
} from "./auto-login";

type ExactBankBrowserOpener = (bankCode: string, cdpUrl: string) => Promise<ScrapeTimeAutoLoginBrowserResult>;

export type BankRuntime = Readonly<{
  bankCode: string;
  cdpUrl: string;
  ensureBrowserSession: EnsureBrowserSession;
  ensureBrowser: ExactBankBrowserOpener;
  sessionChecker: ReadonlySessionChecker;
}>;

export type BankRuntimeResolver = Readonly<{
  cdpUrlForBankCode(bankCode: string): string | undefined;
  ensureBrowserSession: EnsureBrowserSession;
  ensureBrowser: ExactBankBrowserOpener;
  resolveSessionChecker: SessionCheckerResolver;
}>;

export type PopularBankRuntimeDependencies = Readonly<{
  browserRuntime?: BrowserRuntimeDeps;
  createSessionChecker?(cdpUrl: string): ReadonlySessionChecker;
  createBrowserOpener?(options: ScrapeTimeAutoLoginBrowserOpenerOptions): ExactBankBrowserOpener;
}>;

export type BhdPersonalBankRuntimeDependencies = Readonly<{
  browserRuntime?: BrowserRuntimeDeps;
  /** Required until a BHD-specific read-only CDP page implementation is available. */
  createSessionChecker?(cdpUrl: string): ReadonlySessionChecker;
  createBrowserOpener?(options: ScrapeTimeAutoLoginBrowserOpenerOptions): ExactBankBrowserOpener;
}>;

export function createExactBankRuntimeResolver(runtimes: readonly BankRuntime[]): BankRuntimeResolver {
  const runtimeFor = (bankCode: string) => runtimes.find((runtime) => runtime.bankCode === bankCode);
  return Object.freeze({
    cdpUrlForBankCode: (bankCode) => runtimeFor(bankCode)?.cdpUrl,
    ensureBrowserSession: async (bankCode) => runtimeFor(bankCode)
      ? runtimeFor(bankCode)!.ensureBrowserSession(bankCode)
      : { status: "unavailable" },
    ensureBrowser: async (bankCode, cdpUrl) => {
      const runtime = runtimeFor(bankCode);
      if (!runtime || runtime.cdpUrl !== cdpUrl) throw new Error("Bank browser runtime is unavailable");
      return runtime.ensureBrowser(bankCode, cdpUrl);
    },
    resolveSessionChecker: (bankCode) => runtimeFor(bankCode)?.sessionChecker,
  });
}

/** Creates the production-only Popular runtime from its explicit per-bank CDP endpoint. */
export function createPopularBankRuntimeResolver(
  env: Record<string, string | undefined> = process.env,
  dependencies: PopularBankRuntimeDependencies = {},
): BankRuntimeResolver {
  const browser = createBankSessionBrowserConfig(popularBankCode, env, dependencies.browserRuntime);
  if (!browser) return createExactBankRuntimeResolver([]);

  const createSessionChecker = dependencies.createSessionChecker
    ?? ((cdpUrl: string) => createCdpSessionChecker({ cdpUrl }));
  const createBrowserOpener = dependencies.createBrowserOpener ?? createScrapeTimeAutoLoginBrowserOpener;
  return createExactBankRuntimeResolver([Object.freeze({
    bankCode: popularBankCode,
    cdpUrl: browser.cdpUrl,
    ensureBrowserSession: browser.ensureBrowserSession,
    ensureBrowser: createBrowserOpener({
      trustedLoginUrl: popularPortalConfig.baseUrl,
      visibleSelectorTimeoutMs: parseAutoLoginSelectorTimeoutMs(env.RD_SYNC_AUTOLOGIN_SELECTOR_TIMEOUT_MS),
      ensureBrowserRuntime: browser.ensureBrowserRuntime,
      acquireBrowserSlot: createAcquireBrowserSlotFromEnv(env),
    }),
    sessionChecker: createSessionChecker(browser.cdpUrl),
  })]);
}

/**
 * Creates an inert BHD Personal runtime for explicit composition only. It is
 * deliberately not added to the production resolver or worker.
 */
export function createBhdPersonalBankRuntime(
  env: Record<string, string | undefined> = process.env,
  dependencies: BhdPersonalBankRuntimeDependencies = {},
): BankRuntime | undefined {
  if (dependencies.createSessionChecker === undefined) return undefined;

  const browser = createBankSessionBrowserConfig(bhdPersonalBankCode, env, dependencies.browserRuntime);
  if (!browser) return undefined;

  const createBrowserOpener = dependencies.createBrowserOpener ?? createScrapeTimeAutoLoginBrowserOpener;
  return Object.freeze({
    bankCode: bhdPersonalBankCode,
    cdpUrl: browser.cdpUrl,
    ensureBrowserSession: browser.ensureBrowserSession,
    ensureBrowser: createBrowserOpener({
      trustedLoginUrl: bhdPersonalPortalProfile.loginUrl,
      visibleSelectorTimeoutMs: parseAutoLoginSelectorTimeoutMs(env.RD_SYNC_AUTOLOGIN_SELECTOR_TIMEOUT_MS),
      ensureBrowserRuntime: browser.ensureBrowserRuntime,
      acquireBrowserSlot: createAcquireBrowserSlotFromEnv(env),
    }),
    sessionChecker: dependencies.createSessionChecker(browser.cdpUrl),
  });
}
