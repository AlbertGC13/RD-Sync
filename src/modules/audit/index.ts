export interface AuditEventInput {
  actorId: string | null;
  actorRole: string | null;
  action: string;
  target: string;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AuditEvent extends Required<Omit<AuditEventInput, "metadata" | "targetId">> {
  id: string;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

const sensitiveKeys = new Set([
  "cookie",
  "password",
  "rawhtml",
  "screenshot",
  "secret",
  "sessioncookie",
  "sessiontoken",
  "token",
]);

export function createAuditEvent(input: AuditEventInput): AuditEvent {
  return {
    id: crypto.randomUUID(),
    actorId: input.actorId,
    actorRole: input.actorRole,
    action: input.action,
    target: input.target,
    targetId: input.targetId ?? null,
    metadata: input.metadata ? redactAuditMetadata(input.metadata) : null,
    createdAt: new Date(),
  };
}

export function redactAuditMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key, shouldRedact(key) ? "[REDACTED]" : redactValue(value)]),
  );
}

export interface AuditListOptions {
  limit?: number;
  offset?: number;
}

export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
  list(options?: AuditListOptions): Promise<AuditEvent[]>;
}

export class InMemoryAuditSink implements AuditSink {
  private readonly events: AuditEvent[] = [];

  async record(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }

  async list(options?: AuditListOptions): Promise<AuditEvent[]> {
    // Sort newest-first; for equal timestamps preserve insertion order (desc index).
    const sorted = [...this.events].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    const offset = options?.offset ?? 0;
    const sliced = offset > 0 ? sorted.slice(offset) : sorted;
    return options?.limit !== undefined ? sliced.slice(0, options.limit) : sliced;
  }
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (isPlainObject(item) ? redactAuditMetadata(item) : item));
  }

  if (isPlainObject(value)) {
    return redactAuditMetadata(value);
  }

  return value;
}

function shouldRedact(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
  return [...sensitiveKeys].some((sensitive) => normalized.includes(sensitive));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
