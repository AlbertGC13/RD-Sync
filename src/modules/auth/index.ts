export type Role = "admin" | "reviewer" | "viewer";

export interface Principal {
  id: string;
  role: Role;
}

const roleRank: Record<Role, number> = {
  viewer: 1,
  reviewer: 2,
  admin: 3,
};

export function resolvePrincipalFromTrustedHeaders(headers: Headers): Principal | null {
  const id = headers.get("x-rd-sync-user-id")?.trim();
  const role = headers.get("x-rd-sync-role")?.trim().toLowerCase();

  if (!id || !isRole(role)) return null;

  return { id, role };
}

export function requireRole(principal: Principal | null, allowedRoles: readonly Role[]): Principal {
  if (!principal) {
    throw new Error("Authentication required");
  }

  if (!allowedRoles.includes(principal.role)) {
    throw new Error(`Role ${principal.role} is not allowed`);
  }

  return principal;
}

export function canReadTransactions(principal: Principal | null): boolean {
  return hasAtLeastRole(principal, "viewer");
}

export function canReviewTransactions(principal: Principal | null): boolean {
  return hasAtLeastRole(principal, "reviewer");
}

export function assertCanAccessBankSession(principal: Principal | null): Principal {
  if (!principal || !hasAtLeastRole(principal, "admin")) {
    throw new Error("Admin role required");
  }

  return principal;
}

export function hasAtLeastRole(principal: Principal | null, minimumRole: Role): boolean {
  if (!principal) return false;
  return roleRank[principal.role] >= roleRank[minimumRole];
}

function isRole(value: string | undefined): value is Role {
  return value === "admin" || value === "reviewer" || value === "viewer";
}
