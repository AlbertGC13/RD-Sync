/**
 * Prisma-backed implementation of UserRepository.
 *
 * Key decisions:
 * - Email lookup uses Prisma's case-insensitive mode rather than lowercasing
 *   in the application, so collation is handled by the DB.
 * - The highest role is computed by iterating the UserRole join rows and
 *   picking the one with the highest rank (admin > reviewer > viewer).
 * - If the user has no roles, "viewer" is returned as the default.
 * - UserStatus enum keys: ACTIVE → "active", DISABLED → "disabled".
 * - RoleKey enum keys: ADMIN → "admin", REVIEWER → "reviewer", VIEWER → "viewer".
 */

import type { UserAccount, UserRepository } from "../auth/user-repository";
import type { Role } from "../auth/index";
import { getPrismaClient } from "./prisma-client";

const ROLE_RANK: Record<Role, number> = { viewer: 1, reviewer: 2, admin: 3 };

function mapRoleKey(key: string): Role {
  const map: Record<string, Role> = {
    ADMIN: "admin",
    REVIEWER: "reviewer",
    VIEWER: "viewer",
  };
  return map[key] ?? "viewer";
}

function computeHighestRole(roleKeys: string[]): Role {
  let highest: Role = "viewer";
  let highestRank = 0;
  for (const key of roleKeys) {
    const role = mapRoleKey(key);
    if (ROLE_RANK[role] > highestRank) {
      highestRank = ROLE_RANK[role];
      highest = role;
    }
  }
  return highest;
}

export class PrismaUserRepository implements UserRepository {
  private get prisma() {
    return getPrismaClient();
  }

  async findByEmail(email: string): Promise<UserAccount | null> {
    const row = await this.prisma.user.findFirst({
      where: {
        email: { equals: email.toLowerCase(), mode: "insensitive" },
      },
      select: {
        id: true,
        email: true,
        displayName: true,
        status: true,
        passwordHash: true,
        roles: {
          select: {
            role: { select: { key: true } },
          },
        },
      },
    });

    if (!row) return null;

    const roleKeys = row.roles.map((ur) => ur.role.key as string);
    const role = computeHighestRole(roleKeys);

    return {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      role,
      status: row.status === "ACTIVE" ? "active" : "disabled",
      passwordHash: row.passwordHash ?? null,
    };
  }
}
