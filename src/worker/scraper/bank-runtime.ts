import { createCdpSessionChecker } from "../../modules/bank-sessions";
import { popularBankCode } from "../../modules/bank-adapters/popular";
import {
  createBankSessionBrowserConfig,
  type BrowserRuntimeDeps,
  type EnsureBrowserSession,
} from "./browser-runtime";
import type { ReadonlySessionChecker, SessionCheckerResolver } from "./authenticated-session-probe";

export type BankRuntime = Readonly<{
  bankCode: string;
  cdpUrl: string;
  ensureBrowserSession: EnsureBrowserSession;
  sessionChecker: ReadonlySessionChecker;
}>;

export type BankRuntimeResolver = Readonly<{
  cdpUrlForBankCode(bankCode: string): string | undefined;
  ensureBrowserSession: EnsureBrowserSession;
  resolveSessionChecker: SessionCheckerResolver;
}>;

export type PopularBankRuntimeDependencies = Readonly<{
  browserRuntime?: BrowserRuntimeDeps;
  createSessionChecker?(cdpUrl: string): ReadonlySessionChecker;
}>;

export function createExactBankRuntimeResolver(runtimes: readonly BankRuntime[]): BankRuntimeResolver {
  const runtimeFor = (bankCode: string) => runtimes.find((runtime) => runtime.bankCode === bankCode);
  return Object.freeze({
    cdpUrlForBankCode: (bankCode) => runtimeFor(bankCode)?.cdpUrl,
    ensureBrowserSession: async (bankCode) => runtimeFor(bankCode)
      ? runtimeFor(bankCode)!.ensureBrowserSession(bankCode)
      : { status: "unavailable" },
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
  return createExactBankRuntimeResolver([Object.freeze({
    bankCode: popularBankCode,
    cdpUrl: browser.cdpUrl,
    ensureBrowserSession: browser.ensureBrowserSession,
    sessionChecker: createSessionChecker(browser.cdpUrl),
  })]);
}
