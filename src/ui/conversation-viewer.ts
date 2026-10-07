/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 */

import { type AgentSession, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, Markdown, type MarkdownOptions, type MarkdownTheme, matchesKey, type OverlayOptions, ScrollView, type ScrollViewScrollbar, type TUI, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderAgentName } from "../agent-color.js";
import { extractText } from "../context.js";
import type { AgentRecord, ViewerMarkdownMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import type { Theme } from "./agent-widget.js";
import { type AgentActivity, buildInvocationTags, describeActivity, fgPreservingNestedStyles, formatCost, formatDuration, formatSessionTokens, getPromptModeLabel } from "./agent-widget.js";
import { collapseOutput, previewsTail, renderToolCall, TOOL_INDENT } from "./tool-block.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

/** Base lines consumed by chrome: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES_BASE = 6;
const MIN_VIEWPORT = 3;
/** Height ceiling shared by the overlay's `maxHeight` and the viewer's internal viewport cap. */
export const VIEWPORT_HEIGHT_PCT = 70;
const SCROLLBAR_WIDTH = 1;
/** One column per character, no escapes: a line this matches is as wide as it is long. */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** What a click on a recorded span does: send a key, jump to the end, or place the composer cursor. */
type HitAction = { key: string } | { latest: true } | { composer: true };
interface HitTarget { row: number; start: number; end: number; action: HitAction }

/** Follow the active renderer, not a setting that may require a restart. */
export function getConversationOverlayOptions(tui: Pick<TUI, "mode">): OverlayOptions {
  return tui.mode === "fullscreen"
    ? { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 }
    : { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` };
}

/**
 * Cap on a single tool result or bash output before the viewer elides the rest.
 *
 * The cap is not cosmetic — it bounds render cost. `buildContentLines()` runs on
 * every render *and* on every scroll key (`handleInput` calls it to compute
 * `maxScroll`), so an uncapped 200 KB result costs ~6 ms per keystroke to parse
 * as Markdown, against ~0.5 ms once capped and effectively nothing on a cache
 * hit (best of 5, width 76). 16 KB is roughly a screenful at every terminal size
 * and still ~30x the 500 characters this replaces, which was small enough to cut
 * most real results mid-sentence.
 */
export const RESULT_MAX_CHARS = 16_000;

/** Cycle order for the viewer's `m` key. */
const MARKDOWN_MODES: readonly ViewerMarkdownMode[] = ["off", "assistant", "all"];

/** Footer labels — short, because the idle footer is already full at 80 columns. */
const MARKDOWN_MODE_LABELS: Record<ViewerMarkdownMode, string> = {
  off: "raw",
  assistant: "md",
  all: "md+",
};

/**
 * Both options keep the renderer from *rewriting* source that only looks like
 * Markdown: without them `3) a / 7) b / 9) c` comes back renumbered `3. 4. 5.`
 * and backslash escapes are normalized away. Neither is a safe edit to make to
 * a tool's output, and both are cheap to switch off.
 */
const MARKDOWN_OPTIONS: MarkdownOptions = {
  preserveOrderedListMarkers: true,
  preserveBackslashEscapes: true,
};

/**
 * Pi's own Markdown theme when this process has one, else a theme built from the
 * viewer's `Theme`.
 *
 * Preferring pi's is what buys syntax-highlighted code fences (it carries a
 * `highlightCode`), and it keeps this surface consistent with the notification
 * renderer, which uses the same source. It has to be *probed* rather than
 * try/caught around the call: `getMarkdownTheme()` returns arrow functions that
 * read pi's global theme lazily, so an uninitialized theme throws inside
 * `render()` — long after this returns — and takes the overlay with it. That is
 * the case in tests and any embedded session that never called `initTheme()`.
 */
function resolveMarkdownTheme(th: Theme): MarkdownTheme {
  try {
    const piTheme = getMarkdownTheme();
    piTheme.heading("probe");
    return piTheme;
  } catch {
    return fallbackMarkdownTheme(th);
  }
}

/**
 * `Theme` carries only `fg` and `bold`, so the three remaining styles are
 * written as raw SGR. Rendering them as plain text instead would silently drop
 * `*emphasis*`'s markers with nothing in their place, turning a formatting
 * change into a content change.
 */
function fallbackMarkdownTheme(th: Theme): MarkdownTheme {
  const sgr = (on: number, off: number) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;
  return {
    heading: text => th.bold(th.fg("accent", text)),
    link: text => th.fg("accent", text),
    linkUrl: text => th.fg("muted", text),
    code: text => th.fg("muted", text),
    codeBlock: text => th.fg("muted", text),
    codeBlockBorder: text => th.fg("dim", text),
    quote: text => th.fg("muted", text),
    quoteBorder: text => th.fg("dim", text),
    hr: text => th.fg("dim", text),
    listBullet: text => th.fg("accent", text),
    bold: text => th.bold(text),
    italic: sgr(3, 23),
    underline: sgr(4, 24),
    strikethrough: sgr(9, 29),
  };
}

/**
 * Cap `text` at `RESULT_MAX_CHARS`, reporting the elision separately rather than
 * appending it.
 *
 * Separately because the notice is the viewer's chrome, not the tool's output.
 * Appended into the string it becomes content: a cut landing inside a fenced
 * code block — likely, on exactly the large `ctx_execute` results this is for —
 * renders the notice as a line of source inside the fence.
 *
 * `fromEnd` keeps the tail instead — for shell output, where the newest lines
 * are the ones that matter and the collapsed preview shows the end.
 */
function capResult(text: string, fromEnd = false): { text: string; elided: number } {
  if (text.length <= RESULT_MAX_CHARS) return { text, elided: 0 };
  return {
    text: fromEnd ? text.slice(-RESULT_MAX_CHARS) : text.slice(0, RESULT_MAX_CHARS),
    elided: text.length - RESULT_MAX_CHARS,
  };
}

/**
 * `999` · `1.5k` · `8.4M` — a magnitude cue, not an exact count, past 1000.
 *
 * The bracket is chosen against the *rounded* value, so 999,999 reads `1M`
 * rather than the `1000.0k` a naive `< 1e6` test produces.
 */
function humanCount(n: number): string {
  if (n < 1_000) return `${n}`;
  const thousands = n < 999_950;
  const value = thousands ? n / 1_000 : n / 1_000_000;
  return `${value.toFixed(1).replace(/\.0$/, "")}${thousands ? "k" : "M"}`;
}

function truncationNote(elided: number, fromEnd = false): string {
  return `... (truncated, ${humanCount(elided)} ${fromEnd ? "earlier" : "more"} character${elided === 1 ? "" : "s"})`;
}

export class ConversationViewer implements Component, Focusable {
  private scrollOffset = 0;
  private autoScroll = true;
  focused = false;
  private readonly fullscreen: boolean;
  private viewport: { width: number; top: number; height: number; maxScroll: number; thumbTop: number; thumbHeight: number } | undefined;
  private scrollbarGrabOffset: number | undefined;
  /** Clickable spans recorded by the last fullscreen render, in screen cells. */
  private hitTargets: HitTarget[] = [];
  private newMessages = 0;
  private readonly scrollView: ScrollView;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  /** Two-press confirm guard for the stop key, so a stray key can't kill the agent. */
  private stopArmed = false;
  private keys: ViewerKeys;
  /** Steering composer — present while the user is typing a message to the agent. */
  private composer: Input | undefined;
  /** Resolved once: pi's Markdown theme is fixed for the life of the process. */
  private readonly markdownTheme: MarkdownTheme;
  /** Set by the `m` key. Wins over the setting so `m` works without a persist hook. */
  private markdownModeOverride: ViewerMarkdownMode | undefined;
  /**
   * One `Markdown` per message, so its own text/width cache does the work. A
   * fresh instance per render would re-parse the whole transcript on every
   * keystroke — the component caches, but only across calls to the same object.
   * Weak so a compacted-away message doesn't pin its render.
   */
  private readonly markdownCache = new WeakMap<object, { md: Markdown; text: string; failed?: boolean }>();
  /**
   * Streamed output of tools still running, by `toolCallId`. Viewer-local: it
   * only fills from updates seen while open, which a streaming tool sends often.
   */
  private readonly partials = new Map<string, string>();
  /** Re-renders once a second while a tool runs, so its runtime ticks without events. */
  private ticker: ReturnType<typeof setInterval> | undefined;

  constructor(
    private tui: TUI,
    private session: AgentSession,
    private record: AgentRecord,
    private activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (result: undefined) => void,
    /** Abort the agent shown here. Omitted → no stop affordance (e.g. read-only history). */
    private onStop?: () => void,
    /** User keybindings from `ctx.ui.custom()`. Omitted → hardcoded defaults. */
    keybindings?: ViewerKeybindings,
    /** Send a steering message to the agent. Omitted → no compose affordance. */
    private onSteer?: (message: string) => void,
    /**
     * Whether the header shows an estimated cost after the token count. Read
     * once, at construction: the overlay is opened from a menu, so the setting
     * cannot change while it is on screen.
     */
    private showCost = false,
    /**
     * The current `viewerMarkdown` setting. Read live rather than captured,
     * unlike `showCost`: `m` changes it while the overlay is on screen.
     * Omitted → `assistant`.
     */
    private viewerMarkdown?: () => ViewerMarkdownMode,
    /**
     * Persist a mode chosen with `m`, so the key and `/agents → Settings` mean
     * the same thing. Omitted → `m` still cycles, viewer-locally.
     */
    private onMarkdownMode?: (mode: ViewerMarkdownMode) => void,
    /** Pi's fullscreen scrollbar preference, captured when the observer opens. */
    scrollbarMode: ScrollViewScrollbar = "auto",
    /**
     * Pi's tool expansion state when the viewer opened. Toggled locally with
     * pi's expand key afterwards, without touching the main transcript.
     */
    private toolsExpanded = false,
  ) {
    this.fullscreen = tui.mode === "fullscreen";
    this.markdownTheme = resolveMarkdownTheme(theme);
    this.keys = createViewerKeys(keybindings);
    this.scrollView = new ScrollView({
      render: width => this.buildContentLines(width),
      invalidate: () => {},
    }, { follow: "end", scrollbar: this.fullscreen ? scrollbarMode : "hidden" });
    this.unsubscribe = session.subscribe(event => {
      if (this.closed) return;
      if (event.type === "tool_execution_update") {
        const content = event.partialResult?.content;
        this.partials.set(event.toolCallId, Array.isArray(content) ? extractText(content) : "");
      } else if (event.type === "tool_execution_end") {
        this.partials.delete(event.toolCallId);
      }
      if (this.fullscreen && !this.scrollView.isFollowingEnd && event.type === "message_start" && ["user", "assistant", "toolResult", "bashExecution"].includes(event.message.role)) {
        this.newMessages++;
      }
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (this.fullscreen && (matchesKey(data, "ctrl+end") || (!this.composer && matchesKey(data, "end")))) {
      this.jumpToLatest();
      return;
    }
    // While composing a steer message, the input owns all keys (Enter sends,
    // Esc cancels — both wired in openComposer()). Editing keys flow through.
    if (this.composer) {
      this.composer.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    // Enter opens the steering composer (only while the agent can still be
    // steered) — then type + Enter sends, Esc or an empty submit returns. When
    // not steerable, fall through so the key still disarms a pending stop.
    if (matchesKey(data, "enter") && this.canSteer()) {
      this.stopArmed = false;
      this.openComposer();
      return;
    }

    // Stop/abort the agent (only while it can still be stopped). Two-press:
    // first "x" arms, second confirms — any other key disarms.
    if (matchesKey(data, "x")) {
      if (this.isStoppable()) {
        if (this.stopArmed) {
          this.stopArmed = false;
          this.onStop?.();
        } else {
          this.stopArmed = true;
        }
        this.tui.requestRender();
      }
      return;
    }

    // Cycle raw → assistant-only → everything. The escape hatch that makes
    // Markdown rendering safe to default on: a result the renderer reshapes
    // (a diff, an indented log, a `#`-commented script) is one key from verbatim.
    if (matchesKey(data, "m")) {
      this.stopArmed = false;
      const next = MARKDOWN_MODES[(MARKDOWN_MODES.indexOf(this.markdownMode()) + 1) % MARKDOWN_MODES.length];
      this.markdownModeOverride = next;
      this.onMarkdownMode?.(next);
      this.tui.requestRender();
      return;
    }
    if (this.keys.toggleExpand(data)) {
      this.stopArmed = false;
      this.toolsExpanded = !this.toolsExpanded;
      this.tui.requestRender();
      return;
    }
    if (this.stopArmed) this.stopArmed = false;

    const totalLines = this.buildContentLines(this.lastInnerW).length;
    const viewportHeight = this.viewportHeight();
    if (this.fullscreen) {
      this.scrollView.updateLayout(totalLines, viewportHeight, () => {
        if (!this.closed) this.tui.requestRender();
      });
      if (this.keys.scrollUp(data)) this.scrollView.scrollBy(-1);
      else if (this.keys.scrollDown(data)) this.scrollView.scrollBy(1);
      else if (this.keys.pageUp(data)) this.scrollView.scrollBy(-viewportHeight);
      else if (this.keys.pageDown(data)) this.scrollView.scrollBy(viewportHeight);
      else if (matchesKey(data, "home")) this.scrollView.scrollToStart();
      return;
    }
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    if (this.keys.scrollUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.scrollDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.pageUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (this.keys.pageDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  private jumpToLatest(): void {
    this.scrollView.scrollToEnd();
    this.newMessages = 0;
    this.stopArmed = false;
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
    if (!this.fullscreen) return { handled: false };
    // Every cell belongs to this observer. Even unused clicks/drags must not
    // fall through to Pi's transcript selection, scrolling, or editor.
    if (this.closed || !this.viewport) return { handled: true, render: false };
    const view = this.viewport;
    const onScrollbar = this.scrollView.scrollbar !== "hidden" && event.x >= view.width - SCROLLBAR_WIDTH && event.x < view.width && event.y >= view.top && event.y < view.top + view.height;
    if (event.type === "move") {
      this.scrollView.setScrollbarActive(onScrollbar);
      return { handled: true, render: false };
    }
    if (event.type === "wheel") {
      this.stopArmed = false;
      this.scrollView.scrollBy(event.wheelDelta ?? 0);
      return { handled: true, render: true };
    }
    if (event.type === "release") {
      const wasDragging = this.scrollbarGrabOffset !== undefined;
      this.scrollbarGrabOffset = undefined;
      this.scrollView.setScrollbarActive(onScrollbar);
      return { handled: true, render: wasDragging };
    }
    if (event.type === "drag" && this.scrollbarGrabOffset !== undefined) {
      const travel = view.height - view.thumbHeight;
      const position = Math.max(0, Math.min(travel, event.y - view.top - this.scrollbarGrabOffset));
      this.scrollView.scrollTo(travel > 0 ? Math.round(position / travel * view.maxScroll) : 0);
      return { handled: true, render: true };
    }
    if (event.type === "press" && event.button === "left") {
      this.scrollbarGrabOffset = undefined;
      this.scrollView.setScrollbarActive(onScrollbar);
      const hit = this.hitTargets.find(t => t.row === event.y && event.x >= t.start && event.x < t.end);
      if (hit && "key" in hit.action) {
        this.handleInput(hit.action.key);
        return { handled: true, render: true };
      }
      this.stopArmed = false;
      if (hit && "latest" in hit.action) {
        this.jumpToLatest();
        return { handled: true, render: true };
      }
      if (hit && this.composer) {
        this.composer.handleMouse({ ...event, x: event.x - hit.start, y: 0, width: this.lastInnerW, height: 1 });
        return { handled: true, render: true };
      }
      if (onScrollbar && view.maxScroll > 0) {
        const y = event.y - view.top;
        if (y >= view.thumbTop && y < view.thumbTop + view.thumbHeight) {
          this.scrollbarGrabOffset = y - view.thumbTop;
          return { handled: true, capture: true, render: true };
        }
        this.scrollView.scrollBy(y < view.thumbTop ? -view.height : view.height);
        // A track click still pages, but holding it can grab the thumb too.
        this.scrollbarGrabOffset = Math.floor(view.thumbHeight / 2);
        return { handled: true, capture: true, render: true };
      }
      return { handled: true, render: true };
    }
    return { handled: true, render: false };
  }

  render(width: number): string[] {
    this.hitTargets = [];
    this.viewport = undefined;
    this.updateTicker();
    const rows = Math.max(0, this.tui.terminal.rows);
    if (!this.fullscreen && width < 6) return []; // too narrow for any meaningful rendering
    if (width <= SCROLLBAR_WIDTH + 1) return Array.from({ length: rows }, () => " ".repeat(Math.max(0, width)));
    const th = this.theme;
    const innerW = this.fullscreen ? this.scrollView.getContentWidth(width - 1) : width - 4;
    this.lastInnerW = innerW;
    const lines: string[] = [];
    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string, scrollbar?: string): string => {
      if (this.fullscreen) {
        const contentWidth = width - 1 - (scrollbar ? SCROLLBAR_WIDTH : 0);
        return " " + truncateToWidth(content, contentWidth, scrollbar ? "" : "...", true) + (scrollbar ?? "");
      }
      return th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW, "...", true) + " " + th.fg("border", "│");
    };
    // Record a clickable span of `content` as `row()` will place it: one cell in,
    // and only if truncation leaves the whole span ahead of the "...".
    const addTarget = (rowIndex: number, start: number, text: string, action: HitAction, content: string): void => {
      if (!this.fullscreen) return;
      const contentWidth = visibleWidth(content);
      const limit = 1 + (contentWidth <= width - 1 ? contentWidth : width - 4);
      const end = 1 + start + visibleWidth(text);
      if (end <= limit) this.hitTargets.push({ row: rowIndex, start: 1 + start, end, action });
    };
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    // Header
    if (!this.fullscreen) lines.push(hrTop);
    const modeLabel = getPromptModeLabel(this.record.type);
    const modeTag = modeLabel ? ` ${th.fg("dim", `(${modeLabel})`)}` : "";
    const statusIcon = this.record.status === "running"
      ? th.fg("accent", "●")
      : this.record.status === "completed"
        ? th.fg("success", "✓")
        : this.record.status === "error"
          ? th.fg("error", "✗")
          : th.fg("dim", "○");
    const duration = formatDuration(this.record.startedAt, this.record.completedAt);

    const headerParts: string[] = [duration];
    const toolUses = this.activity?.toolUses ?? this.record.toolUses;
    if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    // Spend from the record, context from the live session: the record is the
    // only total that survives the agent finishing and the only one carrying a
    // nested child's spend.
    const tokens = getLifetimeTotal(this.record.lifetimeUsage);
    if (tokens > 0) {
      const percent = getSessionContextPercent(this.activity?.session);
      headerParts.push(formatSessionTokens(tokens, percent, th, this.record.compactionCount));
    }
    const cost = this.showCost ? formatCost(getLifetimeCost(this.record.lifetimeUsage)) : "";
    if (cost) headerParts.push(cost);

    lines.push(row(
      `${statusIcon} ${renderAgentName(this.record.type, th, { bold: true })}${modeTag}  ${th.fg("muted", this.record.description)} ${th.fg("dim", "·")} ${fgPreservingNestedStyles(th, "dim", headerParts.join(" · "))}`,
    ));
    const invocationLine = this.invocationLine();
    if (invocationLine) lines.push(row(invocationLine));
    lines.push(hrMid);

    // Content area — rebuild every render (live data, no cache needed)
    const contentLines = this.fullscreen ? this.scrollView.render(width - 1) : this.buildContentLines(innerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);
    if (this.fullscreen) {
      this.scrollView.updateLayout(contentLines.length, viewportHeight, () => {
        if (!this.closed) this.tui.requestRender();
      });
      if (this.scrollView.isFollowingEnd) this.newMessages = 0;
    } else if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = this.fullscreen ? this.scrollView.scrollTop : Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);
    // Match Pi's scrollbar geometry: rounded size, at least two rows when available.
    const thumbHeight = Math.min(viewportHeight, Math.max(2, Math.round(viewportHeight * viewportHeight / Math.max(1, contentLines.length))));
    const thumbTop = maxScroll > 0 ? Math.round(visibleStart / maxScroll * (viewportHeight - thumbHeight)) : 0;
    this.viewport = { width, top: lines.length, height: viewportHeight, maxScroll, thumbTop, thumbHeight };

    for (let i = 0; i < viewportHeight; i++) {
      let scrollbar: string | undefined;
      if (this.scrollView.isScrollbarVisible) {
        const onThumb = i >= thumbTop && i < thumbTop + thumbHeight;
        if (onThumb) {
          scrollbar = th.fg("scrollbarThumb", this.scrollView.isScrollbarActive ? "█" : "┃");
        } else {
          scrollbar = th.fg("scrollbarTrack", "│");
        }
      }
      lines.push(row(visible[i] ?? "", scrollbar));
    }

    // Keep the divider pinned above the footer, with the jump control centered
    // inside it. Neither scrolling nor new messages change its position.
    if (this.fullscreen && !this.scrollView.isFollowingEnd && maxScroll > 0 && rows >= this.chromeLines()) {
      const text = this.newMessages > 0
        ? `${this.newMessages} new message${this.newMessages === 1 ? "" : "s"}`
        : "Jump to latest message";
      const label = truncateToWidth(`[ ↓ ${text} · Ctrl+End ]`, innerW, "…");
      const labelWidth = visibleWidth(label);
      const padding = Math.floor((innerW - labelWidth) / 2);
      const divider = th.fg("dim", "─".repeat(padding)) + th.fg("accent", label) + th.fg("dim", "─".repeat(innerW - padding - labelWidth));
      addTarget(lines.length, padding, label, { latest: true }, divider);
      lines.push(row(divider));
    } else {
      lines.push(hrMid);
    }
    if (this.composer) {
      // Composer row: the Input renders its own `> ` prompt and cursor.
      this.composer.focused = this.focused;
      const composerRow = " ".repeat(innerW);
      addTarget(lines.length, 0, composerRow, { composer: true }, composerRow);
      lines.push(row(this.composer.render(innerW)[0] ?? ""));
      const composeHint = th.fg("dim", "Enter send · Esc cancel");
      const composeLeft = th.fg("accent", "✎ steer");
      const composeGap = Math.max(1, innerW - visibleWidth(composeLeft) - visibleWidth(composeHint));
      const composeLine = composeLeft + " ".repeat(composeGap) + composeHint;
      const hintStart = visibleWidth(composeLeft) + composeGap;
      addTarget(lines.length, hintStart, "Enter send", { key: "\r" }, composeLine);
      addTarget(lines.length, hintStart + visibleWidth("Enter send · "), "Esc cancel", { key: "\x1b" }, composeLine);
      lines.push(row(composeLine));
    } else {
      // Actions on the left, navigation on the right. The scroll hint keeps its
      // full key list so the less-obvious bindings stay discoverable; it leads
      // the right group so "Esc close" is the only part that truncates first.
      const sep = th.fg("dim", " · ");
      const footerActions: { label: string; key: string }[] = [];
      if (this.canSteer()) footerActions.push({ label: "Enter steer", key: "\r" });
      if (this.isStoppable()) {
        footerActions.push({ label: this.stopArmed ? "x again to STOP" : "x stop", key: "x" });
      }
      // Abbreviated (`raw`/`md`/`md+`) because the idle footer is already full
      // at 80 columns with steer + stop present, and this group has no
      // degradation step below "drop the line-count readout".
      footerActions.push({ label: `m ${MARKDOWN_MODE_LABELS[this.markdownMode()]}`, key: "m" });
      const actions = footerActions.map(a => th.fg(a.key === "x" && this.stopArmed ? "error" : "dim", a.label));
      const footerRight = th.fg("dim", "↑↓ scroll · PgUp/PgDn or Shift+↑↓ · Esc close");

      // Prepend the line-count/scroll-% readout only when there's spare width —
      // it's the first thing dropped so it never crowds out the hints.
      const scrollPct = contentLines.length <= viewportHeight
        ? "100%"
        : `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`;
      const count = th.fg("dim", `${contentLines.length} lines · ${scrollPct}`);
      const withCount = [count, ...actions].join(sep);
      const showCount = visibleWidth(withCount) + visibleWidth(footerRight) + 1 <= innerW;
      const footerLeft = showCount ? withCount : actions.join(sep);

      const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
      const footerLine = footerLeft + " ".repeat(footerGap) + footerRight;
      // Each action's column comes from the segments before it, never from searching the text.
      let col = showCount ? visibleWidth(count) + visibleWidth(sep) : 0;
      for (const action of footerActions) {
        addTarget(lines.length, col, action.label, { key: action.key }, footerLine);
        col += visibleWidth(action.label) + visibleWidth(sep);
      }
      // "Esc close" ends the right-hand hint.
      addTarget(lines.length, visibleWidth(footerLine) - visibleWidth("Esc close"), "Esc close", { key: "\x1b" }, footerLine);
      lines.push(row(footerLine));
    }
    if (!this.fullscreen) {
      lines.push(hrBot);
      return lines;
    }
    // Keep the footer on screen even in a terminal shorter than the chrome. Its
    // targets move with it; targets on rows that were cut stop being clickable.
    const footerRow = lines.length - 1;
    const footer = lines.pop() ?? row("");
    const output = rows > 0 ? [...lines.slice(0, rows - 1), footer] : [];
    const lastRow = output.length - 1;
    this.hitTargets = this.hitTargets.flatMap(t =>
      t.row === footerRow ? (lastRow >= 0 ? [{ ...t, row: lastRow }] : []) : t.row < lastRow ? [t] : []);
    return output;
  }

  /** Stoppable only when a stop handler exists and the agent is still active. */
  private isStoppable(): boolean {
    return !!this.onStop && (this.record.status === "running" || this.record.status === "queued");
  }

  /** The mode in force: an `m` press, else the setting, else the default. */
  private markdownMode(): ViewerMarkdownMode {
    return this.markdownModeOverride ?? this.viewerMarkdown?.() ?? "assistant";
  }

  /** Wrap `text` literally — the pre-Markdown path, and the fallback from it. */
  private rawLines(text: string, width: number, dim: boolean): string[] {
    const lines = wrapTextWithAnsi(text, width);
    return dim ? lines.map(l => this.theme.fg("dim", l)) : lines;
  }

  /** Render `text` as Markdown, reusing this message's component instance. */
  private markdownLines(msg: AgentSession["messages"][number], text: string, width: number, dim: boolean): string[] {
    let entry = this.markdownCache.get(msg);
    if (!entry) {
      entry = {
        md: new Markdown(
          text,
          0,
          0,
          this.markdownTheme,
          // Keeps result prose visually receded, the way the raw path's
          // per-line `fg("dim", …)` did. Fenced code is the exception and is
          // left alone deliberately: pi's theme highlights it with its own
          // colors, which this would otherwise flatten.
          dim ? { color: (t: string) => this.theme.fg("dim", t) } : undefined,
          MARKDOWN_OPTIONS,
        ),
        text,
      };
      this.markdownCache.set(msg, entry);
    } else if (entry.text !== text) {
      // Streaming: the message object is stable, its text grows. A failed
      // prefix remains unsafe after append-only deltas, so retry only when the
      // content was replaced or truncated.
      const shouldRetry = !text.startsWith(entry.text);
      entry.md.setText(text);
      entry.text = text;
      if (shouldRetry) entry.failed = false;
    }
    if (entry.failed) return this.rawLines(text, width, dim);

    try {
      return entry.md.render(width);
    } catch {
      // The parser is recursive and this is arbitrary tool output: ~54 nested
      // blockquotes overflow the stack, and no amount of fuzzing proves that is
      // the only such input. `render()` is on the TUI's critical path, so a
      // throw here takes the overlay down for content the literal path shows
      // fine — degrade to that instead, and remember, since the throw would
      // otherwise repeat on every render and every scroll key.
      entry.failed = true;
      return this.rawLines(text, width, dim);
    }
  }

  /** Steerable only when a steer handler exists and the agent is still active. */
  private canSteer(): boolean {
    return !!this.onSteer && (this.record.status === "running" || this.record.status === "queued");
  }

  /** Open the inline steering composer and route subsequent input to it. */
  private openComposer(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value: string) => {
      const message = value.trim();
      this.composer = undefined;
      if (message) this.onSteer?.(message);
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.composer = undefined;
      this.tui.requestRender();
    };
    this.composer = input;
    this.tui.requestRender();
  }

  invalidate(): void { /* no cached state to clear */ }

  /** Run the runtime ticker only while the agent has a tool in flight. */
  private updateTicker(): void {
    const running = this.record.status === "running"
      && [...(this.record.toolTimings?.values() ?? [])].some(t => t.endedAt === undefined);
    if (running && !this.ticker && !this.closed) {
      this.ticker = setInterval(() => {
        if (!this.closed) this.tui.requestRender();
      }, 1000);
    } else if (!running && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  dispose(): void {
    this.closed = true;
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
    this.scrollView.setScrollbar("hidden"); // clears Pi's auto-hide timer
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  // ---- Private ----

  private viewportHeight(): number {
    if (this.fullscreen) return Math.max(0, this.tui.terminal.rows - this.chromeLines());
    // Cap mirrors the overlay's maxHeight — otherwise the viewer would render
    // more lines than the overlay shows and clip the footer.
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  private chromeLines(): number {
    // The composer adds one row above the footer hint while it's open.
    return CHROME_LINES_BASE - (this.fullscreen ? 2 : 0) + (this.invocationLine() ? 1 : 0) + (this.composer ? 1 : 0);
  }

  private invocationLine(): string | undefined {
    // Canonical id here, short label everywhere else: this overlay is opened to
    // inspect one agent and has the width for it, and two providers can serve
    // models whose short names read alike.
    const { modelName, modelId, tags } = buildInvocationTags(this.record.invocation);
    const model = modelId ?? modelName;
    const parts = model ? [model, ...tags] : tags;
    if (parts.length === 0) return undefined;
    return this.theme.fg("dim", `  ↳ ${parts.join(" · ")}`);
  }

  private buildContentLines(width: number): string[] {
    if (width <= 0) return [];

    const th = this.theme;
    const messages = this.session.messages;
    const lines: string[] = [];

    if (messages.length === 0) {
      lines.push(th.fg("dim", "(waiting for first message...)"));
      return lines;
    }

    const mode = this.markdownMode();
    // Results rendered inside their call's block, so the loop below skips them.
    const results = new Map<string, Extract<AgentSession["messages"][number], { role: "toolResult" }>>();
    for (const msg of messages) {
      if (msg.role === "toolResult") results.set(msg.toolCallId, msg);
    }
    const calledIds = new Set<string>();
    let needsSeparator = false;
    for (const msg of messages) {
      if (msg.role === "user") {
        const text = typeof msg.content === "string"
          ? msg.content
          : extractText(msg.content);
        if (!text.trim()) continue;
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(th.fg("accent", "[User]"));
        for (const line of wrapTextWithAnsi(text.trim(), width)) {
          lines.push(line);
        }
      } else if (msg.role === "assistant") {
        const textParts: string[] = [];
        const toolCalls: Extract<(typeof msg.content)[number], { type: "toolCall" }>[] = [];
        for (const c of msg.content) {
          if (c.type === "text" && c.text) textParts.push(c.text);
          else if (c.type === "toolCall") toolCalls.push(c);
        }
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(th.bold("[Assistant]"));
        if (textParts.length > 0) {
          const text = textParts.join("\n").trim();
          lines.push(...(mode === "off"
            ? this.rawLines(text, width, false)
            : this.markdownLines(msg, text, width, false)));
        }
        for (const call of toolCalls) {
          calledIds.add(call.id);
          lines.push(...this.toolBlockLines(call.id, call.name, call.arguments, results.get(call.id), width));
        }
      } else if (msg.role === "toolResult") {
        if (calledIds.has(msg.toolCallId)) continue;
        // Orphaned from its call (e.g. compacted away): the result alone.
        const output = this.toolOutputLines(msg, extractText(msg.content).trim(), previewsTail(msg.toolName), width, "");
        if (output.length === 0) continue;
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(th.fg("dim", "[Result]"));
        lines.push(...output);
      } else if ((msg as any).role === "bashExecution") {
        const bash = msg as any;
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(truncateToWidth(th.fg("muted", `  $ ${bash.command}`), width));
        // Never Markdown: command output is the one thing here that is
        // definitionally not authored as Markdown.
        lines.push(...this.toolOutputLines(undefined, bash.output?.trim() ?? "", true, width, ""));
      } else {
        continue;
      }
      needsSeparator = true;
    }

    // Streaming indicator for running agents
    if (this.record.status === "running" && this.activity) {
      const act = describeActivity(this.activity.activeTools, this.activity.responseText);
      lines.push("");
      lines.push(truncateToWidth(th.fg("accent", "▍ ") + th.fg("dim", act), width));
    }

    // Clamp only what overflows. `truncateToWidth` returns a fitting line
    // unchanged, but reaching that answer takes its slow grapheme path on any
    // line with an escape or non-ASCII character — every themed line — so on a
    // styled transcript this map was most of the render. Plain short lines are
    // settled by the regex; the rest by `visibleWidth`, which is cached.
    return lines.map(l =>
      (l.length <= width && PRINTABLE_ASCII.test(l)) || visibleWidth(l) <= width ? l : truncateToWidth(l, width));
  }

  /** One tool call: header, arguments, then its result — or its live output while it runs. */
  private toolBlockLines(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
    result: Extract<AgentSession["messages"][number], { role: "toolResult" }> | undefined,
    width: number,
  ): string[] {
    const timing = this.record.toolTimings?.get(toolCallId);
    const text = result ? extractText(result.content).trim() : (this.partials.get(toolCallId) ?? "").trim();
    return [
      ...renderToolCall({ name: toolName, args, timing, isError: !!result?.isError }, this.toolsExpanded, width, this.theme),
      ...this.toolOutputLines(result, text, previewsTail(toolName), width, TOOL_INDENT),
    ];
  }

  /**
   * Tool output, capped at `RESULT_MAX_CHARS` and collapsed by `collapseOutput`.
   * `msg` keys the Markdown cache; without one (live output, `!` commands) the
   * text takes the literal path.
   */
  private toolOutputLines(msg: AgentSession["messages"][number] | undefined, raw: string, fromEnd: boolean, width: number, indent: string): string[] {
    if (!raw) return [];
    const innerW = Math.max(1, width - indent.length);
    const { text, elided } = capResult(raw, fromEnd);
    const out = collapseOutput(
      msg && this.markdownMode() === "all" ? this.markdownLines(msg, text, innerW, true) : this.rawLines(text, innerW, true),
      { expanded: this.toolsExpanded, fromEnd, expandKeyLabel: this.keys.expandKeyLabel, indent, theme: this.theme },
    );
    // Only meaningful when expanded: collapsed, the hidden-lines prompt already covers it.
    if (elided && this.toolsExpanded) {
      const note = truncateToWidth(this.theme.fg("dim", indent + truncationNote(elided, fromEnd)), width);
      if (fromEnd) out.unshift(note);
      else out.push(note);
    }
    return out;
  }
}
