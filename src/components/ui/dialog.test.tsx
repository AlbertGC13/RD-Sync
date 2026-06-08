import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog";

// DialogTitle and DialogDescription are present in the import surface so other
// components can compose them, but Radix only renders their content when the
// dialog is opened. The render test asserts the trigger and the imports are wired.

describe("Dialog", () => {
  it("exports the Dialog subcomponents", () => {
    // Radix primitives are objects that wrap multiple subcomponents.
    expect(Dialog).toBeDefined();
    expect(DialogTrigger).toBeDefined();
    expect(DialogContent).toBeDefined();
    expect(DialogHeader).toBeDefined();
    expect(DialogTitle).toBeDefined();
    expect(DialogDescription).toBeDefined();
  });

  it("renders the trigger as a Radix button", () => {
    const html = renderToStaticMarkup(
      <Dialog>
        <DialogTrigger>Open dialog</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Title</DialogTitle>
            <DialogDescription>Description</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>,
    );

    // Radix mounts the trigger button immediately; the content portal renders
    // only when the dialog opens, so we assert the trigger is present.
    expect(html).toContain("Open dialog");
    expect(html).toContain("aria-haspopup=\"dialog\"");
  });
});
