/**
 * UserAccount type, UserRepository interface, and InMemoryUserRepository.
 *
 * The `role` field on UserAccount represents the highest-ranked role assigned
 * to the user. If a user has no roles, "viewer" is used as the default.
 */

import type { Role } from "./index";

export interface UserAccount {
  id: string;
  email: string;
  displayName: string;
  /** Highest-ranked role. Falls back to "viewer" when no roles are assigned. */
  role: Role;
  status: "active" | "disabled";
  passwordHash: string | null;
}

export interface UserRepository {
  findByEmail(email: string): Promise<UserAccount | null>;
}

/**
 * In-memory implementation of UserRepository.
 * Accepts a seed array at construction time; used in tests and dev mode.
 * Email lookup is case-insensitive.
 */
export class InMemoryUserRepository implements UserRepository {
  constructor(private readonly users: readonly UserAccount[]) {}

  async findByEmail(email: string): Promise<UserAccount | null> {
    const normalized = email.toLowerCase();
    return this.users.find((u) => u.email.toLowerCase() === normalized) ?? null;
  }
}
