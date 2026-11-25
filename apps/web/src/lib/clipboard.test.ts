import assert from "node:assert";
import { describe, test, afterEach } from "node:test";
import { copyToClipboard } from "./clipboard";

describe("Clipboard Helper & Event Handling", () => {
  const originalWindowDesc = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalDocumentDesc = Object.getOwnPropertyDescriptor(globalThis, "document");

  function setGlobalProp(prop: string, value: unknown) {
    Object.defineProperty(globalThis, prop, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }

  function restoreGlobalProp(prop: string, desc: PropertyDescriptor | undefined) {
    if (desc) {
      Object.defineProperty(globalThis, prop, desc);
    } else {
      delete (globalThis as Record<string, unknown>)[prop];
    }
  }

  afterEach(() => {
    restoreGlobalProp("window", originalWindowDesc);
    restoreGlobalProp("navigator", originalNavigatorDesc);
    restoreGlobalProp("document", originalDocumentDesc);
  });

  test("copyToClipboard returns false when text is empty", async () => {
    const success = await copyToClipboard("");
    assert.strictEqual(success, false);
  });

  test("copyToClipboard uses modern navigator.clipboard.writeText when available", async () => {
    let writtenText = "";

    const mockClipboard = {
      writeText: async (t: string) => {
        writtenText = t;
      },
    };

    // Set up mock window and navigator
    const mockWindow = {} as Window & typeof globalThis;
    const mockNavigator = {
      clipboard: mockClipboard,
    } as unknown as Navigator;

    setGlobalProp("window", mockWindow);
    setGlobalProp("navigator", mockNavigator);

    const payload = "CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT";
    const success = await copyToClipboard(payload);

    assert.strictEqual(success, true);
    assert.strictEqual(writtenText, payload);
  });

  test("copyToClipboard falls back to document.execCommand when navigator.clipboard fails", async () => {
    let execCommandAction = "";
    let appendedChild: unknown = null;
    let removedChild: unknown = null;

    const mockTextarea = {
      value: "",
      style: {},
      setAttribute: () => {},
      focus: () => {},
      select: () => {},
      setSelectionRange: () => {},
    };

    const mockDocument = {
      createElement: (tag: string) => {
        if (tag === "textarea") {
          return mockTextarea;
        }
        return {};
      },
      body: {
        appendChild: (el: unknown) => {
          appendedChild = el;
        },
        removeChild: (el: unknown) => {
          removedChild = el;
        },
      },
      execCommand: (command: string) => {
        execCommandAction = command;
        return true;
      },
    };

    // Navigator clipboard throws
    const mockNavigator = {
      clipboard: {
        writeText: async () => {
          throw new Error("Permission denied");
        },
      },
    } as unknown as Navigator;

    const mockWindow = {
      document: mockDocument,
    } as unknown as Window & typeof globalThis;

    setGlobalProp("window", mockWindow);
    setGlobalProp("document", mockDocument);
    setGlobalProp("navigator", mockNavigator);

    const payload = "0x9483756382910384756291028475629102847562";
    const success = await copyToClipboard(payload);

    assert.strictEqual(success, true);
    assert.strictEqual(execCommandAction, "copy");
    assert.strictEqual(mockTextarea.value, payload);
    assert.strictEqual(appendedChild, mockTextarea);
    assert.strictEqual(removedChild, mockTextarea);
  });

  test("copyToClipboard falls back to document.execCommand when navigator.clipboard is unavailable", async () => {
    let execCommandCalled = false;

    const mockTextarea = {
      value: "",
      style: {},
      setAttribute: () => {},
      focus: () => {},
      select: () => {},
      setSelectionRange: () => {},
    };

    const mockDocument = {
      createElement: () => mockTextarea,
      body: {
        appendChild: () => {},
        removeChild: () => {},
      },
      execCommand: (cmd: string) => {
        if (cmd === "copy") {
          execCommandCalled = true;
          return true;
        }
        return false;
      },
    };

    const mockWindow = {
      document: mockDocument,
    } as unknown as Window & typeof globalThis;

    setGlobalProp("window", mockWindow);
    setGlobalProp("document", mockDocument);
    setGlobalProp("navigator", {});

    const payload = "GBZXN7PIRZGNMHGA728KLMS729DNMC718290";
    const success = await copyToClipboard(payload);

    assert.strictEqual(success, true);
    assert.strictEqual(execCommandCalled, true);
    assert.strictEqual(mockTextarea.value, payload);
  });
});
