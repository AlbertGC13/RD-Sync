import { describe, expect, it } from "vitest";

import { notImplemented } from "./not-implemented";

describe("notImplemented server action", () => {
  it("returns a not_implemented result for review", async () => {
    const result = await notImplemented({ feature: "review" });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "not_implemented", feature: "review" });
    if (!result.ok) {
      expect(result.message).toContain("upcoming change");
    }
  });

  it("returns a not_implemented result for retry with Hito 2 message", async () => {
    const result = await notImplemented({ feature: "retry" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Hito 2");
    }
  });

  it("never mutates state — the action has no side effects", async () => {
    const before = await notImplemented({ feature: "disable" });
    const after = await notImplemented({ feature: "disable" });
    expect(before).toEqual(after);
  });
});
