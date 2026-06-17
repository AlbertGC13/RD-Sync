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

import { InMemoryUserRepository } from "../auth/user-repository";
import type { UserAccount } from "../auth/user-repository";
import { runUserRepositoryContract } from "./contracts/user-repository.contract";

const userSeeds: UserAccount[] = [
  {
    id: "u-alice",
    email: "alice@example.com",
    displayName: "Alice",
    role: "admin",
    status: "active",
    passwordHash: "hash1",
  },
  {
    id: "u-reviewer",
    email: "reviewer@example.com",
    displayName: "Reviewer",
    role: "reviewer",
    status: "active",
    passwordHash: null,
  },
  {
    id: "u-admin",
    email: "admin@example.com",
    displayName: "Admin",
    role: "admin",
    status: "active",
    passwordHash: "hash3",
  },
  {
    id: "u-norole",
    email: "norole@example.com",
    displayName: "NoRole",
    role: "viewer",
    status: "active",
    passwordHash: null,
  },
];

runUserRepositoryContract(async () => ({
  repo: new InMemoryUserRepository(userSeeds),
  cleanup: async () => {},
}));