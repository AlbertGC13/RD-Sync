import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "./drawer";

describe("Drawer", () => {
  it("exports the Drawer subcomponents", () => {
    // Radix primitives are objects that wrap multiple subcomponents.
    expect(Drawer).toBeDefined();
    expect(DrawerTrigger).toBeDefined();
    expect(DrawerClose).toBeDefined();
    expect(DrawerContent).toBeDefined();
    expect(DrawerHeader).toBeDefined();
    expect(DrawerTitle).toBeDefined();
    expect(DrawerDescription).toBeDefined();
  });

  it("renders the trigger as a Radix button", () => {
    const html = renderToStaticMarkup(
      <Drawer>
        <DrawerTrigger>Open filters</DrawerTrigger>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Filters</DrawerTitle>
            <DrawerDescription>Narrow the result set</DrawerDescription>
          </DrawerHeader>
        </DrawerContent>
      </Drawer>,
    );

    // Trigger renders immediately; the drawer content portal renders when opened.
    expect(html).toContain("Open filters");
    expect(html).toContain("aria-haspopup=\"dialog\"");
  });
});
