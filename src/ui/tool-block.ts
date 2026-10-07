/**
 * tool-block.ts — How the conversation viewer draws one tool call.
 *
 * A header with runtime and (for bash) timeout, the call's arguments under it,
 * then its output collapsed to a few lines with a hidden-lines prompt. Pure:
 * the viewer owns the state (live output, expand toggle, Markdown cache) and
 * passes in what these need.
 *
 * Lines come back unclamped: the viewer clamps every content line to width
 * once, at the end of `buildContentLines`. Clamping here as well would double
 * the cost of a header or prompt line, and those carry `·`/`…`, which sends
 * pi-tui's `truncateToWidth` down its slow grapheme path (~9 µs a line).
 */

import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ToolTiming } from "../types.js";
import { formatMs, type Theme } from "./agent-widget.js";

/** Lines of tool output shown while tool output is collapsed. */
export const TOOL_PREVIEW_LINES = 3;

/** Indent of a tool block's `[Tool …]` header. */
const TOOL_HEADER_INDENT = "  ";

/** Indent of a tool block's arguments and output under its header. */
export const TOOL_INDENT = "    ";

/** Shell output previews its tail, like pi's own bash renderer; everything else its head. */
export function previewsTail(toolName: string): boolean {
  return toolName === "bash";
}

/**
 * The summary of a call's arguments shown under its header: the command for
 * bash, the path or pattern for the file tools, compact JSON for anything else.
 */
export function formatToolArgs(toolName: string, args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const str = (key: string) => typeof args[key] === "string" ? args[key] as string : undefined;
  switch (toolName) {
    case "bash": return str("command") ?? "";
    case "read":
    case "write":
    case "edit": return str("path") ?? "";
    case "grep":
    case "find":
    case "ls": return [str("pattern"), str("path")].filter(Boolean).join("  ");
    default: {
      const json = JSON.stringify(args);
      return json === "{}" ? "" : json;
    }
  }
}

/**
 * `[Tool Bash · 1.0s · 15s timeout]` — runtime only once timing is known. Bash
 * always states its timeout, `no timeout` included: pi's bash has no default,
 * so an absent value means the command can run forever.
 */
export function toolHeader(toolName: string, args: Record<string, unknown> | undefined, timing: ToolTiming | undefined): string {
  const parts = [`Tool ${toolName.charAt(0).toUpperCase()}${toolName.slice(1)}`];
  if (timing) parts.push(formatMs((timing.endedAt ?? Date.now()) - timing.startedAt));
  if (toolName === "bash") parts.push(typeof args?.timeout === "number" ? `${args.timeout}s timeout` : "no timeout");
  return `[${parts.join(" · ")}]`;
}

/**
 * The call half of a tool block: header, then arguments in the header's color,
 * aligned with the output. Collapsed, a multi-line argument shows its first
 * line and ` …`; expanded, all of it, wrapped.
 */
export function renderToolCall(
  call: { name: string; args: Record<string, unknown> | undefined; timing: ToolTiming | undefined; isError: boolean },
  expanded: boolean,
  width: number,
  th: Theme,
): string[] {
  const color = call.isError ? "error" : "muted";
  const lines = [th.fg(color, `${TOOL_HEADER_INDENT}${toolHeader(call.name, call.args, call.timing)}`)];
  const argText = formatToolArgs(call.name, call.args).trim();
  if (argText) {
    const argLines = expanded
      ? wrapTextWithAnsi(argText, Math.max(1, width - TOOL_INDENT.length))
      : [argText.split("\n")[0] + (argText.includes("\n") ? " …" : "")];
    for (const line of argLines) lines.push(th.fg(color, TOOL_INDENT + line));
  }
  return lines;
}

/**
 * Indent rendered output and, while collapsed, keep `TOOL_PREVIEW_LINES` of it
 * — the tail when `fromEnd`, else the head — with a dim line saying how many
 * are hidden and which key shows them, on the side the lines were cut from.
 */
export function collapseOutput(
  lines: string[],
  opts: { expanded: boolean; fromEnd: boolean; expandKeyLabel: string; indent: string; theme: Theme },
): string[] {
  const hidden = opts.expanded ? 0 : Math.max(0, lines.length - TOOL_PREVIEW_LINES);
  const kept = hidden === 0 ? lines : opts.fromEnd ? lines.slice(-TOOL_PREVIEW_LINES) : lines.slice(0, TOOL_PREVIEW_LINES);
  const out = kept.map(l => opts.indent + l);
  if (hidden > 0) {
    const prompt = opts.theme.fg("dim", `${opts.indent}… ${hidden} ${opts.fromEnd ? "earlier" : "more"} line${hidden === 1 ? "" : "s"} hidden · ${opts.expandKeyLabel} to expand`);
    if (opts.fromEnd) out.unshift(prompt);
    else out.push(prompt);
  }
  return out;
}
