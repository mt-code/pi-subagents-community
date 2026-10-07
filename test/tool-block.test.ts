import { describe, expect, it } from "vitest";
import { collapseOutput, formatToolArgs, toolHeader } from "../src/ui/tool-block.js";

const plain = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any;

describe("formatToolArgs", () => {
  it("summarizes each built-in by its main argument", () => {
    expect(formatToolArgs("bash", { command: "ls -la", timeout: 5 })).toBe("ls -la");
    expect(formatToolArgs("read", { path: "src/a.ts", offset: 10 })).toBe("src/a.ts");
    expect(formatToolArgs("grep", { pattern: "TODO", path: "src" })).toBe("TODO  src");
    expect(formatToolArgs("find", { pattern: "*.ts" })).toBe("*.ts");
  });

  it("falls back to compact JSON for other tools, and nothing for no arguments", () => {
    expect(formatToolArgs("Agent", { prompt: "go", n: 2 })).toBe('{"prompt":"go","n":2}');
    expect(formatToolArgs("Agent", {})).toBe("");
    expect(formatToolArgs("bash", undefined)).toBe("");
  });

  it("ignores a main argument of the wrong type", () => {
    expect(formatToolArgs("bash", { command: 42 })).toBe("");
  });
});

describe("toolHeader", () => {
  it("shows runtime and timeout for bash", () => {
    expect(toolHeader("bash", { timeout: 15 }, { startedAt: 1_000, endedAt: 2_000 })).toBe("[Tool Bash · 1.0s · 15s timeout]");
  });

  it("says `no timeout` for bash without one, and omits runtime with no timing", () => {
    expect(toolHeader("bash", { command: "x" }, undefined)).toBe("[Tool Bash · no timeout]");
  });

  it("gives other tools no timeout segment, even with a `timeout` argument", () => {
    expect(toolHeader("read", { timeout: 5 }, { startedAt: 0, endedAt: 250 })).toBe("[Tool Read · 0.3s]");
  });
});

describe("collapseOutput", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i + 1}`);
  const opts = { expanded: false, fromEnd: false, expandKeyLabel: "ctrl+o", indent: "  ", theme: plain };

  it("keeps the head with the prompt below, or the tail with the prompt above", () => {
    expect(collapseOutput(lines(5), opts)).toEqual(["  l1", "  l2", "  l3", "  … 2 more lines hidden · ctrl+o to expand"]);
    expect(collapseOutput(lines(5), { ...opts, fromEnd: true })).toEqual(["  … 2 earlier lines hidden · ctrl+o to expand", "  l3", "  l4", "  l5"]);
  });

  it("uses the singular for one hidden line and adds no prompt when nothing is hidden", () => {
    expect(collapseOutput(lines(4), opts).at(-1)).toBe("  … 1 more line hidden · ctrl+o to expand");
    expect(collapseOutput(lines(3), opts)).toEqual(["  l1", "  l2", "  l3"]);
  });

  it("keeps everything when expanded", () => {
    expect(collapseOutput(lines(5), { ...opts, expanded: true })).toEqual(lines(5).map(l => `  ${l}`));
  });

  it("names the bound expand key", () => {
    expect(collapseOutput(lines(5), { ...opts, expandKeyLabel: "ctrl+e" }).at(-1)).toContain("ctrl+e to expand");
  });
});
