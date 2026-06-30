import { describe, expect, it } from "vitest";

import {
  createBrowserCapacityMonitor,
  type BrowserCapacityMonitorDeps,
} from "./browser-capacity-monitor";
import type { BrowserCapacitySnapshot } from "../../worker/scraper/browser-runtime";
import type { AuditEvent } from "../audit";

// ---------------------------------------------------------------------------
// Test helpers — fake clock, sample queue, sinks
// ---------------------------------------------------------------------------

function makeFakeClock(startMs: number): { clock: () => Date; advance(ms: number): void } {
  let now = startMs;
  return { clock: () => new Date(now), advance: (ms) => { now += ms; } };
}

function makeSampleQueue(snapshots: BrowserCapacitySnapshot[]): () => BrowserCapacitySnapshot {
  let index = 0;
  return () => snapshots[Math.min(index++, snapshots.length - 1)];
}

interface CapacityAlertCall {
  status: "over_capacity" | "recovered";
  active: number;
  queueDepth: number;
  max: number;
  throttleEventsInWindow: number;
  checkedAt: string;
}

function makeAlertSink(): {
  alertSink: { notifyCapacityAttention: (event: CapacityAlertCall) => Promise<void> };
  calls: CapacityAlertCall[];
} {
  const calls: CapacityAlertCall[] = [];
  return {
    alertSink: { notifyCapacityAttention: async (event) => { calls.push(event); } },
    calls,
  };
}

function makeAuditSink(): {
  auditSink: { record: (event: AuditEvent) => Promise<void> };
  events: AuditEvent[];
} {
  const events: AuditEvent[] = [];
  return { auditSink: { record: async (event) => { events.push(event); } }, events };
}

function snapshot(
  active: number,
  queueDepth: number,
  max: number,
  throttleCount: number,
): BrowserCapacitySnapshot {
  return { active, queueDepth, max, throttleCount };
}

const SUSTAIN_MS = 5 * 60_000;
const OVER = snapshot(2, 5, 2, 0); // queueDepth 5 > 2*max(2)=4

function baseDeps(
  overrides: Partial<BrowserCapacityMonitorDeps> = {},
): BrowserCapacityMonitorDeps {
  return { sample: makeSampleQueue([snapshot(1, 0, 2, 0)]), intervalMs: 60_000, ...overrides };
}

describe("createBrowserCapacityMonitor — normal / not-yet-sustained", () => {
  it("does not alert or audit when queueDepth is within threshold", async () => {
    const { alertSink, calls } = makeAlertSink();
    const { auditSink, events } = makeAuditSink();
    const monitor = createBrowserCapacityMonitor(baseDeps({ alertSink, auditSink }));

    const state = await monitor.tick();

    expect(state.status).toBe("normal");
    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("does not alert before the sustain window elapses", async () => {
    const { clock, advance } = makeFakeClock(0);
    const { alertSink, calls } = makeAlertSink();
    const monitor = createBrowserCapacityMonitor(
      baseDeps({ sample: makeSampleQueue([OVER]), alertSink, clock }),
    );

    await monitor.tick();
    advance(SUSTAIN_MS - 1000);
    const state = await monitor.tick();

    expect(state.status).toBe("normal");
    expect(calls).toHaveLength(0);
  });

  it("never reports over_capacity when max is 0 (no NaN/Infinity from the multiplier math)", async () => {
    const { clock, advance } = makeFakeClock(0);
    const { alertSink, calls } = makeAlertSink();
    const monitor = createBrowserCapacityMonitor(
      baseDeps({ sample: makeSampleQueue([snapshot(0, 3, 0, 1)]), alertSink, clock }),
    );

    await monitor.tick();
    advance(SUSTAIN_MS);
    const state = await monitor.tick();

    expect(state.status).toBe("normal");
    expect(calls).toHaveLength(0);
  });
});

describe("createBrowserCapacityMonitor — sustained over threshold", () => {
  it("alerts and audits exactly once on crossing into sustained over_capacity, not again while still sustained, and tracks lastState()", async () => {
    const { clock, advance } = makeFakeClock(0);
    const { alertSink, calls } = makeAlertSink();
    const { auditSink, events } = makeAuditSink();
    const monitor = createBrowserCapacityMonitor(
      baseDeps({ sample: makeSampleQueue([OVER]), alertSink, auditSink, clock }),
    );

    expect(monitor.lastState()).toBeNull();
    await monitor.tick(); // overThresholdSinceMs = 0
    advance(SUSTAIN_MS);
    const state = await monitor.tick(); // now sustained

    expect(state.status).toBe("over_capacity");
    expect(monitor.lastState()).toEqual(state);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: "over_capacity", active: 2, queueDepth: 5, max: 2 });
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("bank_browser_capacity.warning");
    expect(events[0].target).toBe("browser_capacity");
    expect(events[0].targetId).toBeNull();

    advance(60_000);
    await monitor.tick(); // still sustained — must NOT re-alert

    expect(calls).toHaveLength(1);
    expect(events).toHaveLength(1);
  });
});

describe("createBrowserCapacityMonitor — recovery", () => {
  it("alerts and audits exactly once on recovery (fires immediately, no further re-alert on a later normal tick)", async () => {
    const { clock, advance } = makeFakeClock(0);
    const { alertSink, calls } = makeAlertSink();
    const { auditSink, events } = makeAuditSink();
    const monitor = createBrowserCapacityMonitor(
      baseDeps({
        sample: makeSampleQueue([OVER, OVER, snapshot(1, 0, 2, 0)]),
        alertSink,
        auditSink,
        clock,
      }),
    );

    await monitor.tick();
    advance(SUSTAIN_MS);
    await monitor.tick(); // sustained -> over_capacity alert fired
    expect(calls).toHaveLength(1);

    advance(1000); // recovery does not need to be sustained — fires immediately
    const recoveredState = await monitor.tick();

    expect(recoveredState.status).toBe("recovered");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ status: "recovered", active: 1, queueDepth: 0, max: 2 });
    expect(events).toHaveLength(2);
    expect(events[1].action).toBe("bank_browser_capacity.recovered");

    await monitor.tick(); // further normal tick must not re-alert recovery
    expect(calls).toHaveLength(2);
  });
});

describe("createBrowserCapacityMonitor — early drop resets the sustain timer", () => {
  it("requires a fresh 5-minute window after dropping under threshold before reaching sustain", async () => {
    const { clock, advance } = makeFakeClock(0);
    const { alertSink, calls } = makeAlertSink();
    const monitor = createBrowserCapacityMonitor(
      baseDeps({
        sample: makeSampleQueue([OVER, snapshot(1, 0, 2, 0), OVER]),
        alertSink,
        clock,
      }),
    );

    await monitor.tick(); // over, since t=0
    advance(SUSTAIN_MS - 1000);
    await monitor.tick(); // drops to normal before sustain — resets, no alert (never alerted)
    expect(calls).toHaveLength(0);

    advance(SUSTAIN_MS - 1000); // not enough from the fresh window start
    const stillNotSustained = await monitor.tick();
    expect(stillNotSustained.status).toBe("normal");
    expect(calls).toHaveLength(0);
  });
});

describe("createBrowserCapacityMonitor — throttleEventsInWindow", () => {
  it("reports the delta in throttleCount since the previous tick, never negative", async () => {
    const monitor = createBrowserCapacityMonitor(
      baseDeps({
        sample: makeSampleQueue([snapshot(1, 0, 2, 3), snapshot(1, 0, 2, 7), snapshot(1, 0, 2, 0)]),
      }),
    );

    expect((await monitor.tick()).throttleEventsInWindow).toBe(3); // first observation: delta from 0
    expect((await monitor.tick()).throttleEventsInWindow).toBe(4);
    expect((await monitor.tick()).throttleEventsInWindow).toBe(0); // would-be-negative delta clamped to 0
  });
});

describe("createBrowserCapacityMonitor — sink failures are swallowed", () => {
  it("never rejects tick() when alertSink or auditSink throw", async () => {
    const { clock, advance } = makeFakeClock(0);
    const throwingAlertSink = {
      notifyCapacityAttention: async () => { throw new Error("alert transport down"); },
    };
    const throwingAuditSink = { record: async () => { throw new Error("audit sink down"); } };

    const monitor = createBrowserCapacityMonitor(
      baseDeps({
        sample: makeSampleQueue([OVER]),
        alertSink: throwingAlertSink,
        auditSink: throwingAuditSink,
        clock,
      }),
    );

    await monitor.tick();
    advance(SUSTAIN_MS);
    await expect(monitor.tick()).resolves.toMatchObject({ status: "over_capacity" });
  });
});

describe("createBrowserCapacityMonitor — start/stop scheduling", () => {
  it("wires start() to schedule() and stop() to clearSchedule(), both idempotent", () => {
    const scheduleCalls: Array<{ fn: () => void; ms: number }> = [];
    const clearCalls: unknown[] = [];
    let handleCounter = 0;

    const monitor = createBrowserCapacityMonitor(
      baseDeps({
        schedule: (fn, ms) => { scheduleCalls.push({ fn, ms }); return ++handleCounter; },
        clearSchedule: (handle) => { clearCalls.push(handle); },
        intervalMs: 30_000,
      }),
    );

    monitor.start();
    monitor.start(); // idempotent
    expect(scheduleCalls).toHaveLength(1);
    expect(scheduleCalls[0].ms).toBe(30_000);

    monitor.stop();
    monitor.stop(); // idempotent
    expect(clearCalls).toHaveLength(1);
  });
});
