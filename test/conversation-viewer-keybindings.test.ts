import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";
import type { ViewerKeybindings } from "../src/ui/viewer-keys.js";
import { createViewerKeys } from "../src/ui/viewer-keys.js";

const CTRL_P = "\x10";
const CTRL_N = "\x0e";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const SHIFT_UP = "\x1b[1;2A";
const SHIFT_DOWN = "\x1b[1;2B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";

function createEmacsKeybindings(): KeybindingsManager {
  return new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.up": ["up", "ctrl+p"],
    "tui.select.down": ["down", "ctrl+n"],
  });
}

function createViewer(keybindings?: ViewerKeybindings) {
  const tui = {
    mode: "fullscreen",
    terminal: { rows: 20, columns: 80 },
    requestRender: vi.fn(),
  } as any;
  const messages = Array.from({ length: 60 }, (_, i) => ({
    role: "user",
    content: `message ${i}`,
  }));
  const session = {
    messages,
    subscribe: vi.fn(() => vi.fn()),
  } as any;
  const record = {
    id: "test-1",
    type: "general-purpose",
    description: "test agent",
    status: "completed",
    toolUses: 0,
    startedAt: Date.now(),
  } as AgentRecord;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as any;
  const viewer = new ConversationViewer(tui, session, record, undefined, theme, vi.fn(), undefined, keybindings);
  viewer.render(80); // sets the content width and follows the bottom
  return viewer;
}

function visibleContent(viewer: ConversationViewer): string[] {
  return viewer.render(80).slice(2, 18).map(line => line.slice(0, -1).trimEnd());
}

describe("viewer-keys", () => {
  it("honors user keybindings when a manager is provided", () => {
    const keys = createViewerKeys(createEmacsKeybindings());
    expect(keys.scrollUp(CTRL_P)).toBe(true);
    expect(keys.scrollUp(UP)).toBe(true);
    expect(keys.scrollDown(CTRL_N)).toBe(true);
    expect(keys.scrollDown(DOWN)).toBe(true);
  });

  it("falls back to hardcoded defaults without a manager", () => {
    const keys = createViewerKeys();
    expect(keys.scrollUp(UP)).toBe(true);
    expect(keys.scrollUp(CTRL_P)).toBe(false);
    expect(keys.scrollDown(DOWN)).toBe(true);
    expect(keys.scrollDown(CTRL_N)).toBe(false);
    expect(keys.pageUp(PAGE_UP)).toBe(true);
    expect(keys.pageDown(PAGE_DOWN)).toBe(true);
  });

  it("keeps the k/j and shift+arrow aliases with and without a manager", () => {
    for (const keys of [createViewerKeys(), createViewerKeys(createEmacsKeybindings())]) {
      expect(keys.scrollUp("k")).toBe(true);
      expect(keys.scrollDown("j")).toBe(true);
      expect(keys.pageUp(SHIFT_UP)).toBe(true);
      expect(keys.pageDown(SHIFT_DOWN)).toBe(true);
    }
  });

  it("manager with no user overrides behaves like the hardcoded defaults", () => {
    const keys = createViewerKeys(new KeybindingsManager(TUI_KEYBINDINGS, {}));
    expect(keys.scrollUp(UP)).toBe(true);
    expect(keys.scrollDown(DOWN)).toBe(true);
    expect(keys.pageUp(PAGE_UP)).toBe(true);
    expect(keys.pageDown(PAGE_DOWN)).toBe(true);
    expect(keys.scrollUp(CTRL_P)).toBe(false);
    expect(keys.scrollDown(CTRL_N)).toBe(false);
  });

  it("respects rebinding that removes a default key", () => {
    const manager = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.up": "ctrl+p",
    });
    const keys = createViewerKeys(manager);
    expect(keys.scrollUp(CTRL_P)).toBe(true);
    expect(keys.scrollUp(UP)).toBe(false);
  });
});

describe("ConversationViewer custom keybindings", () => {
  it("scrolls with ctrl+p/ctrl+n when bound to tui.select.up/down", () => {
    const viewer = createViewer(createEmacsKeybindings());
    const bottom = visibleContent(viewer);

    viewer.handleInput(CTRL_P);
    expect(visibleContent(viewer).slice(1)).toEqual(bottom.slice(0, -1));
    viewer.handleInput(CTRL_N);
    expect(visibleContent(viewer)).toEqual(bottom);
    viewer.dispose();
  });

  it("keeps arrows and k/j working alongside custom bindings", () => {
    const viewer = createViewer(createEmacsKeybindings());
    const bottom = visibleContent(viewer);

    viewer.handleInput(UP);
    viewer.handleInput("k");
    expect(visibleContent(viewer).slice(2)).toEqual(bottom.slice(0, -2));
    viewer.handleInput(DOWN);
    viewer.handleInput("j");
    expect(visibleContent(viewer)).toEqual(bottom);
    viewer.dispose();
  });

  it("treats ctrl+p/ctrl+n as unbound without a keybindings manager", () => {
    const viewer = createViewer();
    const bottom = visibleContent(viewer);

    viewer.handleInput(CTRL_P);
    viewer.handleInput(CTRL_N);
    expect(visibleContent(viewer)).toEqual(bottom);
    viewer.handleInput(UP);
    expect(visibleContent(viewer).slice(1)).toEqual(bottom.slice(0, -1));
    viewer.dispose();
  });
});
