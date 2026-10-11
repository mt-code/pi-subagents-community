/**
 * tool-block.ts — How the conversation viewer draws one tool call.
 *
 * A header with runtime and (for bash) timeout, the call's arguments under it,
 * then its output collapsed to a few lines with a hidden-lines prompt. Pure:
 * the viewer owns the state (live output, expand toggle, Markdown cache) and
 * passes in what these need.
 *
 * Lines come back unclamped: the viewer clamps each message's lines to width
 * once, as it builds them in `messageLines`. Clamping here as well would double
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

/** Tools whose arguments always shown in full. */
const SUMMARIZED_TOOLS = new Set(["bash", "read", "write", "edit", "grep", "find", "ls"]);

/**
 * The summary of a call's arguments shown under its header: the command for
 * bash, the path or pattern for the file tools, compact JSON for anything else.
 */
export function formatToolArgs(toolName: string, args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  if (!SUMMARIZED_TOOLS.has(toolName)) {
    const json = JSON.stringify(args);
    return json === "{}" ? "" : json;
  }
  const str = (key: string) => typeof args[key] === "string" ? args[key] as string : undefined;
  if (toolName === "bash") return str("command") ?? "";
  if (toolName === "grep" || toolName === "find" || toolName === "ls") return [str("pattern"), str("path")].filter(Boolean).join("  ");
  return str("path") ?? "";
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
 * aligned with the output. A summary (a bash command, a path) is always shown
 * whole, wrapped — only the output collapses. The JSON fallback can be an
 * entire prompt, so collapsed it shows its first line and ` …`.
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
    const argLines = expanded || SUMMARIZED_TOOLS.has(call.name)
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
