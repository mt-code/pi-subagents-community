/**
 * viewer-keys.ts — Scroll and expand key matchers for the conversation viewer.
 *
 * Resolves `tui.select.*` and `app.tools.expand` through the user's keybindings
 * when pi provides a manager, falling back to hardcoded keys otherwise. The viewer's
 * k/j and shift+arrow aliases always work alongside whatever is bound.
 */

import { type KeyId, matchesKey } from "@earendil-works/pi-tui";

/** The keybinding ids the viewer resolves. */
export type ViewerKeybinding =
  | "tui.select.up"
  | "tui.select.down"
  | "tui.select.pageUp"
  | "tui.select.pageDown"
  | "app.tools.expand";

/** Structural subset of pi's `KeybindingsManager` (which satisfies it). */
export interface ViewerKeybindings {
  matches(data: string, keybinding: ViewerKeybinding): boolean;
  getKeys?(keybinding: ViewerKeybinding): string[];
}

export interface ViewerKeys {
  scrollUp(data: string): boolean;
  scrollDown(data: string): boolean;
  pageUp(data: string): boolean;
  pageDown(data: string): boolean;
  /** Pi's "Toggle tool output" key, so the viewer expands tools the way the transcript does. */
  toggleExpand(data: string): boolean;
  /** The first key bound to `toggleExpand`, for hints. */
  expandKeyLabel: string;
}

export function createViewerKeys(keybindings?: ViewerKeybindings): ViewerKeys {
  const matches = (data: string, id: ViewerKeybinding, fallback: KeyId): boolean =>
    keybindings ? keybindings.matches(data, id) : matchesKey(data, fallback);
  return {
    scrollUp: (data) => matches(data, "tui.select.up", "up") || matchesKey(data, "k"),
    scrollDown: (data) => matches(data, "tui.select.down", "down") || matchesKey(data, "j"),
    pageUp: (data) => matches(data, "tui.select.pageUp", "pageUp") || matchesKey(data, "shift+up"),
    pageDown: (data) => matches(data, "tui.select.pageDown", "pageDown") || matchesKey(data, "shift+down"),
    toggleExpand: (data) => matches(data, "app.tools.expand", "ctrl+o"),
    expandKeyLabel: keybindings?.getKeys?.("app.tools.expand")[0] ?? "ctrl+o",
  };
}
