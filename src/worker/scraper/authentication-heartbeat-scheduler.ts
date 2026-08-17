import type { AuthenticationHeartbeatScheduler } from "./authenticated-session-mutation-runner";

export const AUTHENTICATION_HEARTBEAT_LIMITS = Object.freeze({
  lease: Object.freeze({ min: 30_000, max: 900_000 }),
  heartbeat: Object.freeze({ min: 1_000, max: 300_000 }),
});

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const INVALID_CONFIG = "Invalid authentication heartbeat configuration.";
const INVALID_DELAY = "Authentication heartbeat delay must be a positive safe integer.";

export type AuthenticationHeartbeatConfig = Readonly<{ leaseMs: number; heartbeatMs: number }>;
export type AuthenticationHeartbeatSchedulerDependencies<TimerHandle = ReturnType<typeof setTimeout>> = Readonly<{
  delayMs: number;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  cancel?: (timer: TimerHandle) => void;
}>;

function resolveMilliseconds(value: string | undefined, fallback: number, bounds: Readonly<{ min: number; max: number }>): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(INVALID_CONFIG);
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < bounds.min || milliseconds > bounds.max) throw new Error(INVALID_CONFIG);
  return milliseconds;
}

export function resolveAuthenticationHeartbeatConfig(env: Record<string, string | undefined>): AuthenticationHeartbeatConfig {
  const leaseMs = resolveMilliseconds(env.RD_SYNC_AUTHENTICATION_LEASE_MS, DEFAULT_LEASE_MS, AUTHENTICATION_HEARTBEAT_LIMITS.lease);
  const heartbeatMs = resolveMilliseconds(env.RD_SYNC_AUTHENTICATION_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS, AUTHENTICATION_HEARTBEAT_LIMITS.heartbeat);
  if (heartbeatMs >= leaseMs || heartbeatMs * 3 > leaseMs) throw new Error(INVALID_CONFIG);
  return Object.freeze({ leaseMs, heartbeatMs });
}

export function createFixedDelayAuthenticationHeartbeatScheduler<TimerHandle = ReturnType<typeof setTimeout>>(
  dependencies: AuthenticationHeartbeatSchedulerDependencies<TimerHandle>,
): AuthenticationHeartbeatScheduler {
  if (!Number.isSafeInteger(dependencies.delayMs) || dependencies.delayMs <= 0) throw new Error(INVALID_DELAY);
  const schedule = dependencies.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs) as TimerHandle);
  const cancel = dependencies.cancel ?? ((timer: TimerHandle) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  return {
    start(heartbeat) {
      let stopped = false;
      let timerHandle!: TimerHandle;
      let hasPendingTimer = false;
      let inFlight: Promise<void> | undefined;
      let failed = false;
      let failure: unknown;
      let stopPromise: Promise<void> | undefined;

      const rememberFailure = (error: unknown): void => {
        if (!failed) { failed = true; failure = error; }
      };
      const scheduleNext = (initial = false): void => {
        if (stopped || failed) return;
        try { timerHandle = schedule(onTimer, dependencies.delayMs); hasPendingTimer = true; }
        catch (error) { rememberFailure(error); if (initial) throw error; }
      };
      const onTimer = (): void => {
        hasPendingTimer = false;
        if (stopped || failed || inFlight) return;
        const current = Promise.resolve().then(heartbeat);
        inFlight = current;
        void current.then(
          () => { inFlight = undefined; scheduleNext(); },
          (error: unknown) => { inFlight = undefined; rememberFailure(error); },
        );
      };

      scheduleNext(true);
      return {
        stop(): Promise<void> {
          if (stopPromise) return stopPromise;
          stopped = true;
          const timer = timerHandle;
          const hasPending = hasPendingTimer;
          hasPendingTimer = false;
          stopPromise = (async () => {
            let cancelFailure: unknown;
            let cancelled = false;
            if (hasPending) {
              try { cancel(timer); } catch (error) { cancelled = true; cancelFailure = error; }
            }
            try { await inFlight; } catch (error) { rememberFailure(error); }
            if (failed) throw failure;
            if (cancelled) throw cancelFailure;
          })();
          return stopPromise;
        },
      };
    },
  };
}
