export type AuthenticatedIngestionActivation = Readonly<{ status: "enabled" | "disabled" }>;

export function resolveAuthenticatedIngestionActivation(raw: string | undefined): AuthenticatedIngestionActivation {
  return Object.freeze(raw === "enabled" ? { status: "enabled" } : { status: "disabled" });
}
