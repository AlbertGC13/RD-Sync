/**
 * Reusable contract suite for UserRepository implementations.
 *
 * Usage:
 *   import { runUserRepositoryContract } from "./contracts/user-repository.contract";
 *
 *   runUserRepositoryContract(() => Promise.resolve({ repo: new InMemoryUserRepository([...seeds]), cleanup: async () => {} }));
 *
 * The makeRepo factory is called once per describe block; cleanup is called in afterEach.
 * Seed requirements — the repo must contain exactly:
 *   - "alice@example.com"  id="u-alice"   role=admin    status=active  passwordHash="hash1"
 *   - "reviewer@example.com" id="u-reviewer" role=reviewer status=active  passwordHash=null
 *   - "admin@example.com"  id="u-admin"   role=admin    status=active  passwordHash="hash3"
 *   - "norole@example.com" id="u-norole"  role=viewer   status=active  passwordHash=null
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { UserRepository } from "../../auth/user-repository";

export interface UserRepoHandle {
  repo: UserRepository;
  cleanup(): Promise<void>;
}

export function runUserRepositoryContract(
  makeRepo: () => Promise<UserRepoHandle>,
): void {
  describe("UserRepository contract", () => {
    let handle: UserRepoHandle;

    beforeEach(async () => {
      handle = await makeRepo();
    });

    afterEach(async () => {
      await handle.cleanup();
    });

    // -------------------------------------------------------------------------
    // findByEmail — happy path hit
    // -------------------------------------------------------------------------
    it("findByEmail returns the user when email matches", async () => {
      const user = await handle.repo.findByEmail("alice@example.com");
      expect(user).not.toBeNull();
      expect(user?.id).toBe("u-alice");
      expect(user?.email).toBe("alice@example.com");
      expect(user?.role).toBe("admin");
      expect(user?.status).toBe("active");
      expect(user?.passwordHash).toBe("hash1");
    });

    // -------------------------------------------------------------------------
    // findByEmail — miss returns null
    // -------------------------------------------------------------------------
    it("findByEmail returns null for an unknown email", async () => {
      const user = await handle.repo.findByEmail("nobody@example.com");
      expect(user).toBeNull();
    });

    // -------------------------------------------------------------------------
    // findByEmail — case-insensitive
    // -------------------------------------------------------------------------
    it("findByEmail is case-insensitive", async () => {
      const user = await handle.repo.findByEmail("ALICE@EXAMPLE.COM");
      expect(user?.id).toBe("u-alice");
    });

    // -------------------------------------------------------------------------
    // Role computation: reviewer+viewer → reviewer (highest wins)
    // -------------------------------------------------------------------------
    it("computes highest role: user with [reviewer, viewer] roles → reviewer", async () => {
      const user = await handle.repo.findByEmail("reviewer@example.com");
      expect(user?.role).toBe("reviewer");
    });

    // -------------------------------------------------------------------------
    // Role computation: admin+reviewer → admin
    // -------------------------------------------------------------------------
    it("computes highest role: user with [admin, reviewer] roles → admin", async () => {
      const user = await handle.repo.findByEmail("admin@example.com");
      expect(user?.role).toBe("admin");
    });

    // -------------------------------------------------------------------------
    // Role computation: no roles → viewer (default)
    // -------------------------------------------------------------------------
    it("defaults to viewer when user has no roles", async () => {
      const user = await handle.repo.findByEmail("norole@example.com");
      expect(user?.role).toBe("viewer");
    });

    // -------------------------------------------------------------------------
    // null passwordHash round-trip
    // -------------------------------------------------------------------------
    it("returns null passwordHash when no hash is stored", async () => {
      const user = await handle.repo.findByEmail("reviewer@example.com");
      expect(user?.passwordHash).toBeNull();
    });

    // -------------------------------------------------------------------------
    // displayName preserved
    // -------------------------------------------------------------------------
    it("returns the correct displayName", async () => {
      const user = await handle.repo.findByEmail("alice@example.com");
      expect(user?.displayName).toBe("Alice");
    });

    // -------------------------------------------------------------------------
    // id preserved
    // -------------------------------------------------------------------------
    it("returns the correct id", async () => {
      const user = await handle.repo.findByEmail("norole@example.com");
      expect(user?.id).toBe("u-norole");
    });
  });
}
