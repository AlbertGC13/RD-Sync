/**
 * Contract tests for in-memory repository implementations.
 * These always run — no database required.
 */

import { InMemoryTransactionRepository } from "../transactions/index";
import { InMemoryScrapeRunRepository } from "../scrape-runs/index";
import { InMemoryAuditSink } from "../audit/index";

import { runTransactionRepositoryContract } from "./contracts/transaction-repository.contract";
import { runScrapeRunRepositoryContract } from "./contracts/scrape-run-repository.contract";
import { runAuditRepositoryContract } from "./contracts/audit-repository.contract";

runTransactionRepositoryContract(async () => ({
  repo: new InMemoryTransactionRepository(),
  cleanup: async () => {},
}));

runScrapeRunRepositoryContract(async () => ({
  repo: new InMemoryScrapeRunRepository(),
  cleanup: async () => {},
}));

runAuditRepositoryContract(async () => ({
  sink: new InMemoryAuditSink(),
  cleanup: async () => {},
}));
