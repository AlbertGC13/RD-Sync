import { describe, expect, it } from "vitest";

import { cn } from "./utils";

describe("cn", () => {
  it("returns a single string from mixed class name inputs", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  it("filters out falsy values", () => {
    expect(cn("a", false, null, undefined, 0, "b")).toBe("a b");
  });

  it("keeps numeric values that are not zero", () => {
    expect(cn(1, 2, 3)).toBe("1 2 3");
  });

  it("deduplicates conflicting tailwind utilities via tailwind-merge", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  it("preserves non-conflicting tailwind utilities", () => {
    expect(cn("p-2", "mt-2")).toBe("p-2 mt-2");
  });

  it("supports conditional class names via clsx", () => {
    const isActive = true;
    const isDisabled = false;

    expect(cn("base", isActive && "active", isDisabled && "disabled")).toBe("base active");
  });
});
