/**
 * Default user repository singleton.
 *
 * Env-switch: When DATABASE_URL is set (read at module-load time, consistent
 * with the existing pattern), the Prisma-backed user repository is used instead
 * of the in-memory one. Both implementations satisfy the UserRepository interface.
 *
 * The instance is anchored on globalThis so that Next.js dev module-graph
 * hot-reloads and multiple module graphs within the same process share a
 * single instance.
 *
 * In-memory fallback uses an empty seed (no users) — login will always return
 * 401 in dev mode without a database, which is the safe default.
 */

import { InMemoryUserRepository } from "../../../modules/auth/user-repository";
import { PrismaUserRepository } from "../../../modules/persistence/prisma-user-repository";
import type { UserRepository } from "../../../modules/auth/user-repository";

const globalRegistry = globalThis as typeof globalThis & {
  __rdSyncUserRepository?: UserRepository;
};

function createUserRepository(): UserRepository {
  if (process.env.DATABASE_URL) {
    return new PrismaUserRepository();
  }
  return new InMemoryUserRepository([]);
}

export const defaultUserRepository: UserRepository =
  (globalRegistry.__rdSyncUserRepository ??= createUserRepository());
