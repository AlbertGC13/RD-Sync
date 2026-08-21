import { bankAdapterRegistry, buildPopularCdpScraperOptionsFromEnv } from "../../../modules/bank-adapters/registry";
import type { IngestionScraper } from "../../../worker/queues";

export { buildPopularCdpScraperOptionsFromEnv };

export function resolveDefaultScraper(bankCode?: string): IngestionScraper {
  const code = bankCode && bankCode.trim() ? bankCode.trim() : "popular";
  const adapter = bankAdapterRegistry.get(code);
  return adapter?.createScraper() ?? {
    collect: async () => ({ status: "needs_admin_action", movements: [], safeErrorSummary: "Bank not configured for automated scraping" }),
  };
}
