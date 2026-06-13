/**
 * Contract tests for in-memory repository implementations.
 * These always run — no database required.
 */

import { InMemoryTransactionRepository } from "../transactions/index.js";
import { InMemoryScrapeRunRepository } from "../scrape-runs/index.js";
import { InMemoryAuditSink } from "../audit/index.js";

import { runTransactionRepositoryContract } from "./contracts/transaction-repository.contract.js";
import { runScrapeRunRepositoryContract } from "./contracts/scrape-run-repository.contract.js";
import { runAuditRepositoryContract } from "./contracts/audit-repository.contract.js";

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
