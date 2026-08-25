/**
 * A portal code is the routing, credential, and lock identity. A brand code is
 * display-only grouping metadata and must never be used for runtime routing.
 */
export type BankPortalIdentity =
  | Readonly<{ bankCode: "popular"; brandCode: "popular"; portalVariant: "personal_business"; runtimeStatus: "registered" }>
  | Readonly<{ bankCode: "bhd_personal"; brandCode: "bhd"; portalVariant: "personal"; runtimeStatus: "inert" }>
  | Readonly<{ bankCode: "bhd_empresarial"; brandCode: "bhd"; portalVariant: "empresarial"; runtimeStatus: "deferred" }>
  | Readonly<{ bankCode: "banreservas_personas"; brandCode: "banreservas"; portalVariant: "personas"; runtimeStatus: "deferred" }>
  | Readonly<{ bankCode: "banreservas_empresas"; brandCode: "banreservas"; portalVariant: "empresas"; runtimeStatus: "deferred" }>;

export type BankPortalCode = BankPortalIdentity["bankCode"];
export type BankBrandCode = BankPortalIdentity["brandCode"];
export type BankPortalVariant = BankPortalIdentity["portalVariant"];
export type BankPortalRuntimeStatus = BankPortalIdentity["runtimeStatus"];

const popularIdentity = Object.freeze({
  bankCode: "popular",
  brandCode: "popular",
  portalVariant: "personal_business",
  runtimeStatus: "registered",
} as const);

const bhdPersonalIdentity = Object.freeze({
  bankCode: "bhd_personal",
  brandCode: "bhd",
  portalVariant: "personal",
  runtimeStatus: "inert",
} as const);

const bhdEmpresarialIdentity = Object.freeze({
  bankCode: "bhd_empresarial",
  brandCode: "bhd",
  portalVariant: "empresarial",
  runtimeStatus: "deferred",
} as const);

const banreservasPersonasIdentity = Object.freeze({
  bankCode: "banreservas_personas",
  brandCode: "banreservas",
  portalVariant: "personas",
  runtimeStatus: "deferred",
} as const);

const banreservasEmpresasIdentity = Object.freeze({
  bankCode: "banreservas_empresas",
  brandCode: "banreservas",
  portalVariant: "empresas",
  runtimeStatus: "deferred",
} as const);

export const bankPortalIdentities = Object.freeze([
  popularIdentity,
  bhdPersonalIdentity,
  bhdEmpresarialIdentity,
  banreservasPersonasIdentity,
  banreservasEmpresasIdentity,
] as const satisfies readonly BankPortalIdentity[]);

export const bhdPersonalBankCode = bhdPersonalIdentity.bankCode;

const identitiesByBankCode: ReadonlyMap<string, BankPortalIdentity> = new Map(
  bankPortalIdentities.map((identity) => [identity.bankCode, identity]),
);

export function listBankPortalIdentities(): readonly BankPortalIdentity[] {
  return bankPortalIdentities;
}

/** Returns only an exact portal identity; bare brand codes deliberately fail closed. */
export function getBankPortalIdentity(bankCode: string): BankPortalIdentity | undefined {
  return identitiesByBankCode.get(bankCode);
}
