import { describe, expect, it } from "vitest";

import {
  collectBhdPersonalMovements,
  type BhdPersonalPage,
} from "./bhd";

const trustedUrl = "https://ibp.bhd.com.do/#/bhd/product-detail";
const transactionRow = ["27/06/2026", "2638001", "CASH DEPOSIT", "REC-1", "", "RD$ 15,000.00", "RD$ 22,167.94"];

class FakeBhdPersonalPage implements BhdPersonalPage {
  readonly operations: string[] = [];
  private snapshotIndex = 0;

  constructor(private readonly state: {
    url?: string;
    accessState?: "authenticated" | "login" | "security_question" | "protected" | "unknown";
    movementPanelOpen?: boolean;
    rows?: readonly (readonly string[])[];
    snapshots?: readonly (readonly (readonly string[])[])[];
    scrollResults?: readonly boolean[];
    throwOn?: "accessState" | "readVisibleMovementRows";
  } = {}) {}

  async currentUrl(): Promise<string> {
    this.operations.push("currentUrl");
    return this.state.url ?? trustedUrl;
  }

  async accessState(): Promise<"authenticated" | "login" | "security_question" | "protected" | "unknown"> {
    this.operations.push("accessState");
    if (this.state.throwOn === "accessState") throw new Error("portal contents must not escape");
    return this.state.accessState ?? "authenticated";
  }

  async isMovementPanelOpen(): Promise<boolean> {
    this.operations.push("isMovementPanelOpen");
    return this.state.movementPanelOpen ?? false;
  }

  async expandMovementPanel(): Promise<boolean> {
    this.operations.push("expandMovementPanel");
    return true;
  }

  async readVisibleMovementRows(): Promise<readonly (readonly string[])[]> {
    this.operations.push("readVisibleMovementRows");
    if (this.state.throwOn === "readVisibleMovementRows") throw new Error("portal contents must not escape");
    const snapshot = this.state.snapshots?.[this.snapshotIndex++] ?? this.state.rows ?? [];
    return snapshot;
  }

  async scrollMovementTable(): Promise<boolean> {
    this.operations.push("scrollMovementTable");
    return this.state.scrollResults?.[this.operations.filter((operation) => operation === "scrollMovementTable").length - 1] ?? false;
  }
}

describe("collectBhdPersonalMovements", () => {
  it("collects trusted authenticated rows through the only permitted panel expansion", async () => {
    const page = new FakeBhdPersonalPage({ rows: [transactionRow] });

    await expect(collectBhdPersonalMovements(page)).resolves.toMatchObject({
      status: "collected",
      movements: [expect.objectContaining({ bankId: "bhd_personal", amount: "15000.00", direction: "credit" })],
    });
    expect(page.operations).toEqual([
      "currentUrl", "accessState", "isMovementPanelOpen", "expandMovementPanel", "readVisibleMovementRows", "scrollMovementTable",
    ]);
  });

  it("fails closed before DOM evaluation for an untrusted origin or non-product route", async () => {
    for (const url of ["http://ibp.bhd.com.do/#/bhd/product-detail", "https://example.test/#/bhd/product-detail", "https://ibp.bhd.com.do/#/bhd/home"]) {
      const page = new FakeBhdPersonalPage({ url });
      await expect(collectBhdPersonalMovements(page)).resolves.toMatchObject({ status: "unavailable", movements: [] });
      expect(page.operations).toEqual(["currentUrl"]);
    }
  });

  it("blocks login and protected states before the expansion click", async () => {
    for (const accessState of ["login", "security_question", "protected"] as const) {
      const page = new FakeBhdPersonalPage({ accessState });
      await expect(collectBhdPersonalMovements(page)).resolves.toMatchObject({ status: "needs_admin_action", movements: [] });
      expect(page.operations).toEqual(["currentUrl", "accessState"]);
    }
  });

  it("returns an explicit empty collection for an authenticated empty table", async () => {
    const page = new FakeBhdPersonalPage({ movementPanelOpen: true, rows: [] });

    await expect(collectBhdPersonalMovements(page)).resolves.toEqual({ status: "collected", movements: [] });
    expect(page.operations).toEqual(["currentUrl", "accessState", "isMovementPanelOpen", "readVisibleMovementRows"]);
  });

  it("classifies malformed rows and DOM failures without exposing portal errors", async () => {
    await expect(collectBhdPersonalMovements(new FakeBhdPersonalPage({ rows: [["bad"]] }))).resolves.toMatchObject({
      status: "unavailable", safeErrorSummary: "BHD Personal movements could not be safely parsed.", movements: [],
    });
    await expect(collectBhdPersonalMovements(new FakeBhdPersonalPage({ throwOn: "readVisibleMovementRows" }))).resolves.toMatchObject({
      status: "unavailable", safeErrorSummary: "BHD Personal movements are unavailable.", movements: [],
    });
  });

  it("stabilizes visible rows with a bounded number of scrolls", async () => {
    const page = new FakeBhdPersonalPage({
      snapshots: [[transactionRow], [transactionRow, ["27/06/2026", "2638002", "FEE", "REC-2", "RD$ 679.51", "", "RD$ 21,488.43"]], [transactionRow, ["27/06/2026", "2638002", "FEE", "REC-2", "RD$ 679.51", "", "RD$ 21,488.43"]]],
      scrollResults: [true, true],
    });

    await expect(collectBhdPersonalMovements(page)).resolves.toMatchObject({ status: "collected", movements: expect.arrayContaining([expect.objectContaining({ reference: "2638001" }), expect.objectContaining({ reference: "2638002" })]) });
    expect(page.operations.filter((operation) => operation === "scrollMovementTable")).toHaveLength(2);
    expect(page.operations.filter((operation) => operation === "readVisibleMovementRows")).toHaveLength(3);
  });

  it("exposes no login or credential interaction selectors", () => {
    const page: BhdPersonalPage = new FakeBhdPersonalPage();
    expect("fill" in page).toBe(false);
    expect("submit" in page).toBe(false);
  });
});
