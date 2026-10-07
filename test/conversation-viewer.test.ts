import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";

// ── Mock wrapTextWithAnsi ──────────────────────────────────────────────
// We need to control what wrapTextWithAnsi returns to simulate the
// upstream bug (returning lines wider than requested width).
// vi.mock is hoisted and intercepts before conversation-viewer.ts binds
// its import.

let wrapOverride: ((text: string, width: number) => string[]) | null = null;
/** Bumped per `new Markdown(...)`, so a test can assert the per-message cache holds. */
let markdownConstructions = 0;
/** Bumped per Markdown render attempt, including failed ones. */
let markdownRenderCalls = 0;
/** Forces the Markdown component to throw, for the viewer's fallback path. */
let markdownThrows = false;

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const original = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  return {
    ...original,
    Markdown: class extends original.Markdown {
      constructor(...args: ConstructorParameters<typeof original.Markdown>) {
        markdownConstructions++;
        super(...args);
      }
      render(width: number): string[] {
        markdownRenderCalls++;
        // Real trigger is ~54 nested blockquotes overflowing pi-tui's recursive
        // renderer. Forced rather than reproduced: a real overflow costs ~2.4s
        // and its depth depends on the platform's stack limit, so reproducing it
        // makes the test both slow and liable to stop triggering silently.
        if (markdownThrows) throw new RangeError("Maximum call stack size exceeded");
        return super.render(width);
      }
    },
    wrapTextWithAnsi: (...args: [string, number]) => {
      if (wrapOverride) return wrapOverride(...args);
      return original.wrapTextWithAnsi(...args);
    },
  };
});

// Must import AFTER vi.mock declaration (vitest hoists vi.mock but the
// dynamic import of the test subject must happen after)
const { visibleWidth } = await import("@earendil-works/pi-tui");
const { ConversationViewer, RESULT_MAX_CHARS } = await import("../src/ui/conversation-viewer.js");

// ── Helpers ────────────────────────────────────────────────────────────

/** Tell `viewer` its session changed, as the event for an in-place mutation would. */
const emit = (viewer: any) => viewer.session.emit();

function mockTui(rows = 40, columns = 80) {
  return {
    terminal: { rows, columns },
    requestRender: vi.fn(),
  } as any;
}

function mockSession(messages: any[] = []) {
  let listener: (event: any) => void = () => {};
  return {
    messages,
    subscribe: vi.fn((fn: (event: any) => void) => { listener = fn; return vi.fn(); }),
    /** Fire a session event, as a streamed delta would, so the viewer drops its cached transcript. */
    emit: (event: any = { type: "message_update" }) => listener(event),
    state: {},
    dispose: vi.fn(),
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
  } as any;
}

function mockRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "test-1",
    type: "general-purpose",
    description: "test agent",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    ...overrides,
  } as AgentRecord;
}

function ansiTheme() {
  return {
    fg: (_color: string, text: string) => `\x1b[38;5;240m${text}\x1b[0m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  } as any;
}

function assertAllLinesFit(lines: string[], width: number) {
  for (let i = 0; i < lines.length; i++) {
    const vw = visibleWidth(lines[i]);
    expect(vw, `line ${i} exceeds width (${vw} > ${width}): ${JSON.stringify(lines[i])}`).toBeLessThanOrEqual(width);
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  wrapOverride = null;
  markdownConstructions = 0;
  markdownRenderCalls = 0;
  markdownThrows = false;
});

describe("ConversationViewer invocation line", () => {
  /** The `↳` metadata row for a record, or "" when the viewer renders none. */
  function invocationLine(invocation: AgentRecord["invocation"]): string {
    const viewer = new ConversationViewer(
      mockTui(30, 200), mockSession([]), mockRecord({ invocation }), undefined,
      { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any,
      vi.fn(),
    );
    // The row arrives inside the overlay's frame, padded out to the right
    // border; what is under test is the metadata it carries.
    const row = viewer.render(200).find(l => l.includes("↳"));
    return row ? row.slice(row.indexOf("↳")).replace(/\s*│\s*$/, "") : "";
  }

  // The canonical id, not the short label the widget uses: this overlay is
  // opened to inspect one agent and has the width to disambiguate providers.
  it("names the model with its provider", () => {
    expect(invocationLine({
      modelName: "sonnet 4.6",
      modelId: "anthropic/claude-sonnet-4-6",
      thinking: "high",
      maxTurns: 60,
    })).toBe("↳ anthropic/claude-sonnet-4-6 · thinking: high · max turns: 60");
  });

  it("falls back to the short label when no canonical id was captured", () => {
    expect(invocationLine({ modelName: "sonnet 4.6", thinking: "high" }))
      .toBe("↳ sonnet 4.6 · thinking: high");
  });

  it("discloses a model and level the run did not honor", () => {
    expect(invocationLine({
      modelName: "haiku 4.5",
      modelId: "anthropic/claude-haiku-4-5",
      requestedModel: "google/gemini-3-pro",
      thinking: "low",
      requestedThinking: "max",
    })).toBe("↳ anthropic/claude-haiku-4-5 (asked google/gemini-3-pro) · thinking: low (asked max)");
  });

  it("renders no row at all for a record with no invocation", () => {
    expect(invocationLine(undefined)).toBe("");
  });
});

describe("ConversationViewer cost display", () => {
  /** The header line, with a cost of `cost` on the record and showCost `on`. */
  function header(on: boolean, cost: number): string {
    const record = mockRecord({
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost },
    } as Partial<AgentRecord>);
    const viewer = new ConversationViewer(
      mockTui(30, 200), mockSession([]), record, undefined,
      { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any,
      vi.fn(), undefined, undefined, undefined, on,
    );
    return viewer.render(200).join("\n");
  }

  it("shows the cost beside the token count when enabled", () => {
    // The viewer opens on finished agents, whose live activity entry is gone —
    // so this reads the record, and would show nothing if it did not.
    const out = header(true, 0.0042);
    expect(out).toContain("1.2k token");
    expect(out).toContain("~$0.0042");
  });

  it("shows no cost when disabled", () => {
    const out = header(false, 0.0042);
    expect(out).toContain("1.2k token");
    expect(out).not.toContain("$");
  });

  it("shows no cost for a model with no pricing data", () => {
    expect(header(true, 0)).not.toContain("$");
  });
});

describe("ConversationViewer", () => {
  it("closes with Ctrl+C when not composing", () => {
    const done = vi.fn();
    const viewer = new ConversationViewer(
      mockTui(), mockSession(), mockRecord(), undefined, ansiTheme(), done,
    );

    viewer.handleInput("\x03");

    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith(undefined);
  });

  describe("render width safety", () => {
    const widths = [40, 80, 120, 216];

    it("no line exceeds width with empty messages", () => {
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession([]), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with plain text messages", () => {
      const messages = [
        { role: "user", content: "Hello, how are you?" },
        { role: "assistant", content: [{ type: "text", text: "I am fine, thank you for asking." }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("keeps bordered rows exact-width at a double-width truncation boundary", () => {
      const width = 40;
      for (let prefixLength = 0; prefixLength < width; prefixLength++) {
        const viewer = new ConversationViewer(
          mockTui(30, width),
          mockSession([]),
          mockRecord({ description: `${"a".repeat(prefixLength)}界more` }),
          undefined,
          ansiTheme(),
          vi.fn(),
        );

        for (const line of viewer.render(width)) {
          expect(
            visibleWidth(line),
            `prefix ${prefixLength} produced an under-width bordered row: ${JSON.stringify(line)}`,
          ).toBe(width);
        }
      }
    });

    it("no line exceeds width when text is longer than viewport", () => {
      const longLine = "A".repeat(500);
      const messages = [
        { role: "user", content: longLine },
        { role: "assistant", content: [{ type: "text", text: longLine }] },
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: longLine }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with embedded ANSI escape codes in content", () => {
      const ansiText = `\x1b[1mBold heading\x1b[22m and \x1b[31mred text\x1b[0m ${"X".repeat(300)}`;
      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: ansiText }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with long URLs", () => {
      const url = "https://example.com/" + "a/b/c/d/e/".repeat(30) + "?q=" + "x".repeat(100);
      const messages = [
        { role: "assistant", content: [{ type: "text", text: `Check this link: ${url}` }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with wide table-like content", () => {
      const header = "| " + Array.from({ length: 20 }, (_, i) => `Column${i}`).join(" | ") + " |";
      const dataRow = "| " + Array.from({ length: 20 }, () => "value123").join(" | ") + " |";
      const table = [header, dataRow, dataRow, dataRow].join("\n");
      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: table }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with bashExecution messages", () => {
      const messages = [
        {
          role: "bashExecution", command: "cat " + "/very/long/path/".repeat(20) + "file.txt",
          output: "O".repeat(600),
          exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now(),
        },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with running activity indicator", () => {
      const activity = {
        activeTools: new Map([["read", "file.ts"], ["grep", "pattern"]]),
        toolUses: 5, tokens: "10k", responseText: "R".repeat(400),
        session: { getSessionStats: () => ({ tokens: { total: 50000 } }) },
      };
      const messages = [
        { role: "user", content: "do the thing" },
        { role: "assistant", content: [{ type: "text", text: "working on it" }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord({ status: "running" }), activity as any, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with tool calls", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check that." },
            { type: "toolCall", toolUseId: "t1", name: "very_long_tool_name_" + "x".repeat(200), input: {} },
          ],
        },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width at narrow terminal", () => {
      const messages = [
        { role: "user", content: "Hello world, this is a normal sentence." },
        { role: "assistant", content: [{ type: "text", text: "Sure, here's the answer." }] },
      ];
      for (const w of [8, 10, 15, 20]) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with mixed ANSI + unicode content", () => {
      const text = `\x1b[32m✓\x1b[0m Test passed — 日本語テスト ${"あ".repeat(50)} \x1b[33m⚠\x1b[0m`;
      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });
  });

  describe("Markdown rendering", () => {
    /** ANSI stripped, so an assertion is about the text and not the styling. */
    const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

    function viewerFor(
      messages: any[],
      mode?: "off" | "assistant" | "all",
      onMode?: (m: any) => void,
      /** Tall enough that the assertion reads the whole transcript, not the scrolled window. */
      rows = 200,
    ) {
      // Expanded: these tests are about the full result, not the collapsed preview.
      return new ConversationViewer(
        mockTui(rows, 80), mockSession(messages), mockRecord({ status: "completed" }), undefined,
        ansiTheme(), vi.fn(), undefined, undefined, undefined, false,
        mode ? () => mode : undefined, onMode, undefined, true,
      );
    }

    const assistant = (text: string) => [{ role: "assistant", content: [{ type: "text", text }] }];
    const result = (text: string) => [{ role: "toolResult", toolUseId: "t1", content: [{ type: "text", text }] }];

    it("renders assistant Markdown by default instead of raw source markers", () => {
      const out = strip(viewerFor(assistant("# Heading\n\n- first\n- second\n\n**bold**")).render(80).join("\n"));

      expect(out).toContain("Heading");
      expect(out).not.toContain("# Heading");
      expect(out).not.toContain("**bold**");
      expect(out).toContain("bold");
    });

    it("leaves assistant text verbatim under `off`", () => {
      const out = strip(viewerFor(assistant("# Heading\n\n**bold**"), "off").render(80).join("\n"));

      expect(out).toContain("# Heading");
      expect(out).toContain("**bold**");
    });

    // The reason `all` is not the default: a tool result is arbitrary bytes, and
    // a Markdown pass rewrites several constructs that occur constantly in real
    // command output. Each line here is a rewrite reproduced against pi-tui.
    it("leaves tool results byte-exact under the default mode", () => {
      const raw = [
        "#!/bin/sh",
        "# section",
        "3) alpha",
        "7) beta",
        "9) gamma",
        "Section",
        "---",
        "next",
      ].join("\n");
      const out = strip(viewerFor(result(raw)).render(80).join("\n"));

      for (const line of raw.split("\n")) expect(out).toContain(line);
    });

    it("renders tool-result Markdown under `all`", () => {
      const out = strip(viewerFor(result("## ctx_execute\n\n- one\n- two"), "all").render(80).join("\n"));

      expect(out).toContain("ctx_execute");
      expect(out).not.toContain("## ctx_execute");
    });

    it("does not renumber ordered lists even when it does render them", () => {
      const out = strip(viewerFor(result("3) alpha\n7) beta\n9) gamma"), "all").render(80).join("\n"));

      expect(out).toContain("3) alpha");
      expect(out).not.toContain("4. beta");
    });

    it("`m` cycles the mode, persists it, and shows it in the footer", () => {
      const onMode = vi.fn();
      const viewer = viewerFor(assistant("# Heading"), "assistant", onMode);

      expect(strip(viewer.render(80).join("\n"))).toContain("m md");

      viewer.handleInput("m");
      expect(onMode).toHaveBeenLastCalledWith("all");
      expect(strip(viewer.render(80).join("\n"))).toContain("m md+");

      viewer.handleInput("m");
      expect(onMode).toHaveBeenLastCalledWith("off");
      const off = strip(viewer.render(80).join("\n"));
      expect(off).toContain("m raw");
      // The override, not just the label, is what took effect.
      expect(off).toContain("# Heading");

      viewer.handleInput("m");
      expect(onMode).toHaveBeenLastCalledWith("assistant");
    });

    it("`m` still cycles when no persist hook is wired", () => {
      const viewer = viewerFor(assistant("# Heading"), "assistant");
      viewer.handleInput("m");
      viewer.handleInput("m");

      expect(strip(viewer.render(80).join("\n"))).toContain("# Heading");
    });

    it("`m` disarms a pending stop rather than confirming it", () => {
      const onStop = vi.fn();
      const viewer = new ConversationViewer(
        mockTui(200, 80), mockSession(assistant("hi")), mockRecord({ status: "running" }), undefined,
        ansiTheme(), vi.fn(), onStop,
      );

      viewer.handleInput("x");
      viewer.handleInput("m");
      viewer.handleInput("x");

      expect(onStop).not.toHaveBeenCalled();
    });

    it("keeps the footer's navigation hints intact at 80 columns", () => {
      const viewer = new ConversationViewer(
        mockTui(200, 80), mockSession(assistant("hi")), mockRecord({ status: "running" }), undefined,
        ansiTheme(), vi.fn(), vi.fn(), undefined, vi.fn(),
      );
      const lines = viewer.render(80);
      const footer = strip(lines[lines.length - 2]);

      expect(footer).toContain("Enter steer");
      expect(footer).toContain("x stop");
      expect(footer).toContain("m md");
      expect(footer).toContain("Esc close");
    });

    it("caps a tool result at RESULT_MAX_CHARS, not 500, and says what it dropped", () => {
      const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
      const out = strip(viewerFor(result(lines.join("\n")), undefined, undefined, 4000).render(80).join("\n"));

      expect(out).toContain("line 100");                       // far past the old 500-char cut
      expect(out).not.toContain("line 2999");                  // but still bounded
      expect(out).toMatch(/\.\.\. \(truncated, [\d.]+[kM]? more characters\)/);
    });

    it("puts the truncation notice outside the code fence it cut into", () => {
      const text = `\`\`\`js\n${"const a = 1;\n".repeat(2000)}\`\`\``;
      const viewer = viewerFor(result(text), "all", undefined, 4000);
      const content = ((viewer as any).buildContentLines(76) as string[]).map(strip);
      const note = content.find(l => l.includes("... (truncated"));

      // Appended into the content it lands inside the unterminated fence, where
      // it picks up the code-block indent and reads as a line of the tool's source.
      expect(note).toMatch(/^\.\.\. \(truncated, [\d.]+[kM]? more characters\)$/);
    });

    it("reports the exact omitted character count", () => {
      // UTF-16 code units, so the astral character here counts as two.
      const text = `${"x".repeat(RESULT_MAX_CHARS)}😀x`;
      const viewer = viewerFor(result(text));
      const content = ((viewer as any).buildContentLines(76) as string[]).map(strip);

      expect(content).toContain("... (truncated, 3 more characters)");
    });

    it("abbreviates a large omitted count so the notice fits a narrow frame", () => {
      // The notice goes through truncateToWidth at innerW (width - 4). An exact
      // count runs to seven digits on a multi-megabyte result and pushes the
      // notice past 46, where the unit is cut off and only a number survives.
      const text = `${"x".repeat(RESULT_MAX_CHARS)}${"y".repeat(1_100_000)}`;
      const note = viewerFor(result(text)).render(50).map(strip).find(l => l.includes("truncated,"));

      expect(note).toContain("1.1M more characters)");
    });

    it("rounds into the M bracket rather than reporting 1000k", () => {
      // 999,999 / 1000 rounds to 1000.0 — the bracket has to be picked against
      // the rounded value, not the raw one.
      const text = `${"x".repeat(RESULT_MAX_CHARS)}${"y".repeat(999_999)}`;
      const note = strip(viewerFor(result(text)).render(80).join("\n")).split("\n").find(l => l.includes("truncated,"));

      expect(note).toContain("1M more characters");
    });

    it("falls back to literal wrapping once for an unsafe streaming prefix", () => {
      // render() is on the TUI's critical path, so a parser throw must degrade
      // rather than take the overlay down with it.
      const messages = result("# heading");
      const viewer = viewerFor(messages, "all");
      markdownThrows = true;

      expect(() => viewer.render(80)).not.toThrow();
      expect(strip(viewer.render(80).join("\n"))).toContain("# heading");

      // An append-only delta keeps the unsafe prefix, so it must stay literal
      // without retrying the recursive parser on every streamed update.
      messages[0].content[0].text += "\nmore";
      emit(viewer);
      expect(strip(viewer.render(80).join("\n"))).toContain("more");
      expect(markdownRenderCalls).toBe(1);

      markdownThrows = false;
      expect(strip(viewer.render(80).join("\n"))).toContain("# heading");
      expect(markdownRenderCalls).toBe(1);

      // Replacing the failed content can remove the unsafe prefix, so it gets
      // one fresh Markdown attempt instead of staying literal forever.
      messages[0].content[0].text = "## safe";
      emit(viewer);
      const replaced = strip(viewer.render(80).join("\n"));
      expect(markdownRenderCalls).toBe(2);
      expect(replaced).toContain("safe");
      expect(replaced).not.toContain("## safe");
    });

    it("tracks a tool result that keeps growing past the cap", () => {
      // The live case: the capped prefix never changes, so the parse is reused,
      // but the character count being held back has to keep moving.
      const msg = { role: "toolResult", toolUseId: "t", content: [{ type: "text", text: `${"row\n".repeat(4500)}` }] };
      const viewer = viewerFor([msg]);
      const elided = () => {
        const m = strip(((viewer as any).buildContentLines(76) as string[]).join("\n"))
          .match(/truncated, ([\d.]+)([kM]?) more/);
        return Number(m?.[1]) * (m?.[2] === "M" ? 1e6 : m?.[2] === "k" ? 1e3 : 1);
      };

      const before = elided();
      msg.content[0].text += "row\n".repeat(1000);
      emit(viewer);
      const after = elided();

      expect(before).toBeGreaterThan(0);
      expect(after).toBeGreaterThan(before);
      expect(markdownConstructions).toBe(0); // default mode: results take the literal path
    });

    it("leaves a result under the cap untouched", () => {
      // Deliberately between the old 500-char cap and the new one, so the test
      // discriminates the cap's value and not merely its existence.
      const text = `head\n${"filler line\n".repeat(200)}tail`;
      const out = strip(viewerFor(result(text), undefined, undefined, 600).render(80).join("\n"));

      expect(text.length).toBeLessThan(RESULT_MAX_CHARS);
      expect(out).toContain("head");
      expect(out).toContain("tail");
      expect(out).not.toContain("truncated");
    });

    it("caps bash output with the same rule as a tool result, keeping the tail", () => {
      const messages = [{ role: "bashExecution", command: "yes", output: "y\n".repeat(20000) }];
      // The notice leads the tail it kept, above the auto-scrolled window.
      const content = ((viewerFor(messages) as any).buildContentLines(76) as string[]).map(strip);

      expect(content[1]).toMatch(/^\.\.\. \(truncated, [\d.]+[kM]? earlier characters\)$/);
    });

    it("keeps tool results dim even when rendering them as Markdown", () => {
      // Reads the content line directly: every bordered row carries the theme's
      // escape on its `│`, so asserting on rendered output would pass either way.
      const viewer = viewerFor(result("plain result text"), "all");
      const line = (viewer as any).buildContentLines(76)
        .find((l: string) => strip(l).includes("plain result text"));

      expect(line).toContain("\x1b[38;5;240m");
    });

    it("keeps tool results dim on the literal path too", () => {
      const viewer = viewerFor(result("plain result text"));
      const line = (viewer as any).buildContentLines(76)
        .find((l: string) => strip(l).includes("plain result text"));

      expect(line).toContain("\x1b[38;5;240m");
    });

    it("reuses one Markdown per message across renders", () => {
      const viewer = viewerFor(assistant("# Heading"));
      viewer.render(80);
      const afterFirst = markdownConstructions;
      viewer.render(80);
      viewer.render(80);

      expect(afterFirst).toBe(1);
      expect(markdownConstructions).toBe(afterFirst);
    });

    it("re-renders a message whose text is still streaming", () => {
      const messages = assistant("# One");
      const viewer = viewerFor(messages);
      expect(strip(viewer.render(80).join("\n"))).toContain("One");

      messages[0].content[0].text = "# Two";
      emit(viewer);
      const out = strip(viewer.render(80).join("\n"));

      expect(out).toContain("Two");
      expect(out).not.toContain("One");
      expect(markdownConstructions).toBe(1);
    });

    it("renders Markdown to fit, so the overwidth clamp never has to cut it", () => {
      const text = `# ${"Heading ".repeat(20)}\n\n| a | b |\n|---|---|\n| ${"x".repeat(90)} | 2 |\n\n\`\`\`js\nconst x = ${"1".repeat(120)};\n\`\`\``;
      // From 20 up: below that the `[Assistant]` role label is itself wider than
      // the viewport, so the clamp legitimately fires on chrome rather than content.
      // Narrower widths stay covered by the wrapTextWithAnsi safety net above.
      for (const w of [20, 40, 80, 120]) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(assistant(text)), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        const content = (viewer as any).buildContentLines(w) as string[];

        assertAllLinesFit(content, w);
        // `truncateToWidth` is the #7 backstop, not what keeps these in bounds —
        // if it fires on Markdown output, content is being silently cut.
        expect(content.filter(l => strip(l).endsWith("..."))).toEqual([]);
      }
    });
  });

  describe("tool blocks", () => {
    /** Color names inline, so a test can tell an error header from a muted one. */
    const tagTheme = { fg: (c: string, t: string) => `<${c}>${t}`, bold: (t: string) => t } as any;
    const untag = (l: string) => l.replace(/<[a-zA-Z]+>/g, "");
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i + 1}`).join("\n");
    const call = (id: string, name: string, args: Record<string, unknown>) =>
      ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
    const res = (id: string, name: string, text: string, isError = false) =>
      ({ role: "toolResult", toolCallId: id, toolName: name, isError, content: [{ type: "text", text }] });

    function viewerFor(messages: any[], opts: { record?: Partial<AgentRecord>; expanded?: boolean; session?: any; tui?: any } = {}) {
      return new ConversationViewer(
        opts.tui ?? mockTui(200, 80), opts.session ?? mockSession(messages), mockRecord({ status: "completed", ...opts.record }), undefined,
        tagTheme, vi.fn(), undefined, undefined, undefined, false, undefined, undefined, undefined, opts.expanded ?? false,
      );
    }
    const content = (viewer: any): string[] => (viewer.buildContentLines(76) as string[]).map(untag);

    it("heads the call with its runtime and bash timeout, then its command and output directly beneath", () => {
      const viewer = viewerFor([call("c1", "bash", { command: "ls -la", timeout: 15 }), res("c1", "bash", "out")], {
        record: { toolTimings: new Map([["c1", { startedAt: 1_000, endedAt: 2_000 }]]) },
      });
      const out = content(viewer);
      const at = out.indexOf("  [Tool Bash · 1.0s · 15s timeout]");

      expect(at).toBeGreaterThanOrEqual(0);
      expect(out.slice(at + 1, at + 4)).toEqual(["    ls -la", "    out"]);
    });

    it("ends at the command while the call has no output yet", () => {
      const out = content(viewerFor([call("c1", "bash", { command: "sleep 9" })]));

      expect(out.slice(-2)).toEqual(["  [Tool Bash · no timeout]", "    sleep 9"]);
    });

    it("ticks the runtime of a tool still running", () => {
      const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
      try {
        const viewer = viewerFor([call("c1", "bash", { command: "sleep 9" })], {
          record: { status: "running", toolTimings: new Map([["c1", { startedAt: 7_500 }]]) },
        });
        expect(content(viewer)).toContain("  [Tool Bash · 2.5s · no timeout]");
      } finally {
        now.mockRestore();
      }
    });

    it("omits the runtime when no timing was recorded, and the timeout for non-bash tools", () => {
      const out = content(viewerFor([call("c1", "read", { path: "a.ts", timeout: 5 }), res("c1", "read", "x")]));

      expect(out).toContain("  [Tool Read]");
      expect(out).toContain("    a.ts");
    });

    it("colors the arguments like the header, apart from the output", () => {
      const raw = (bash: any) => (viewerFor([call("c1", "bash", { command: "ls -la" }), bash]) as any).buildContentLines(76) as string[];
      const ok = raw(res("c1", "bash", "file-listing"));
      const failed = raw(res("c1", "bash", "file-listing", true));

      expect(ok.find(l => l.includes("ls -la"))).toMatch(/^<muted>/);
      expect(ok.find(l => l.includes("file-listing"))).toMatch(/^ *<dim>/);
      expect(failed.find(l => l.includes("ls -la"))).toMatch(/^<error>/);
    });

    it("colors the header as an error when the result failed", () => {
      const viewer = viewerFor([call("c1", "bash", { command: "false" }), res("c1", "bash", "boom", true)]);
      const header = (viewer as any).buildContentLines(76).find((l: string) => l.includes("[Tool Bash"));

      expect(header).toContain("<error>");
    });

    it("previews the last 3 lines of bash output, with a hidden-lines prompt above", () => {
      const out = content(viewerFor([call("c1", "bash", { command: "seq 10" }), res("c1", "bash", lines(10))]));
      const at = out.indexOf("    … 7 earlier lines hidden · ctrl+o to expand");

      expect(at).toBeGreaterThan(0);
      expect(out.slice(at + 1, at + 4)).toEqual(["    l8", "    l9", "    l10"]);
      expect(out).not.toContain("    l7");
    });

    it("previews the first 3 lines of other tools, with a hidden-lines prompt below", () => {
      const out = content(viewerFor([call("c1", "read", { path: "f" }), res("c1", "read", lines(10))]));
      const at = out.indexOf("    l1");

      expect(out.slice(at, at + 4)).toEqual(["    l1", "    l2", "    l3", "    … 7 more lines hidden · ctrl+o to expand"]);
      expect(out).not.toContain("    l4");
    });

    it("says `line` for one hidden line, and shows no prompt when nothing is hidden", () => {
      expect(content(viewerFor([call("c1", "read", { path: "f" }), res("c1", "read", lines(4))])))
        .toContain("    … 1 more line hidden · ctrl+o to expand");
      expect(content(viewerFor([call("c1", "read", { path: "f" }), res("c1", "read", lines(3))])).join("\n"))
        .not.toContain("hidden");
    });

    it("expands and collapses with ctrl+o", () => {
      const viewer = viewerFor([call("c1", "read", { path: "f" }), res("c1", "read", lines(10))]);
      viewer.render(80);

      viewer.handleInput("\x0f");
      expect(content(viewer)).toContain("    l10");
      expect(content(viewer).join("\n")).not.toContain("hidden");

      viewer.handleInput("\x0f");
      expect(content(viewer)).not.toContain("    l10");
    });

    it("opens expanded when pi's tool output is expanded", () => {
      expect(content(viewerFor([call("c1", "read", { path: "f" }), res("c1", "read", lines(10))], { expanded: true })))
        .toContain("    l10");
    });

    it("shows only the first line of multi-line arguments until expanded", () => {
      const messages = [call("c1", "bash", { command: "echo a\necho b" })];

      expect(content(viewerFor(messages))).toContain("    echo a …");
      expect(content(viewerFor(messages))).toContain("  [Tool Bash · no timeout]");
      const expanded = content(viewerFor(messages, { expanded: true }));
      expect(expanded).toContain("    echo a");
      expect(expanded).toContain("    echo b");
    });

    it("streams live output from tool_execution_update until the tool ends", () => {
      const session = mockSession([call("c1", "bash", { command: "make" })]);
      const tui = mockTui(200, 80);
      const viewer = viewerFor([], { session, tui });
      const emit = session.subscribe.mock.calls[0][0];

      emit({ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "building..." }] } });
      expect(content(viewer)).toContain("    building...");
      expect(tui.requestRender).toHaveBeenCalled();

      emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: {}, isError: false });
      expect(content(viewer).join("\n")).not.toContain("building...");
    });

    it("renders a result once, inside its call's block, but keeps an orphaned one", () => {
      const out = content(viewerFor([
        call("c1", "read", { path: "f" }), res("c1", "read", "matched output"),
        res("gone", "read", "orphan output"),
      ]));

      expect(out.filter(l => l.includes("matched output"))).toHaveLength(1);
      expect(out.filter(l => l === "[Result]")).toHaveLength(1);
      expect(out).toContain("orphan output");
    });

    it("re-renders every second while a tool runs, and stops once disposed", () => {
      vi.useFakeTimers();
      try {
        const tui = mockTui(200, 80);
        const viewer = viewerFor([call("c1", "bash", { command: "sleep 9" })], {
          tui, record: { status: "running", toolTimings: new Map([["c1", { startedAt: Date.now() }]]) },
        });
        viewer.render(80);
        tui.requestRender.mockClear();

        vi.advanceTimersByTime(2_000);
        expect(tui.requestRender).toHaveBeenCalledTimes(2);

        viewer.dispose();
        vi.advanceTimersByTime(2_000);
        expect(tui.requestRender).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("runs no ticker once every tool has finished", () => {
      vi.useFakeTimers();
      try {
        const tui = mockTui(200, 80);
        const viewer = viewerFor([call("c1", "bash", { command: "ls" })], {
          tui, record: { status: "running", toolTimings: new Map([["c1", { startedAt: 0, endedAt: 1 }]]) },
        });
        viewer.render(80);
        tui.requestRender.mockClear();

        vi.advanceTimersByTime(3_000);
        expect(tui.requestRender).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("rebuilds the transcript on each runtime tick, with no session event", () => {
      vi.useFakeTimers();
      try {
        const viewer = viewerFor([call("c1", "bash", { command: "sleep 9" })], {
          record: { status: "running", toolTimings: new Map([["c1", { startedAt: Date.now() }]]) },
        });
        viewer.render(80);
        expect(content(viewer).join("\n")).toContain("[Tool Bash · 0.0s");

        vi.advanceTimersByTime(1_000);
        expect(content(viewer).join("\n")).toContain("[Tool Bash · 1.0s");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("safety net against upstream wrapTextWithAnsi bugs", () => {
    // These tests call buildContentLines() directly (via the private method)
    // because render() has its own truncation via row(). The safety net in
    // buildContentLines is what prevents the TUI crash — it must clamp
    // independently of render().

    /** Call the private buildContentLines method directly. */
    function callBuildContentLines(viewer: InstanceType<typeof ConversationViewer>, width: number): string[] {
      return (viewer as any).buildContentLines(width);
    }

    it("mock is intercepting wrapTextWithAnsi", async () => {
      const { wrapTextWithAnsi } = await import("@earendil-works/pi-tui");
      wrapOverride = () => ["MOCK_SENTINEL"];
      expect(wrapTextWithAnsi("anything", 10)).toEqual(["MOCK_SENTINEL"]);
      wrapOverride = null;
    });

    it("clamps overwidth lines from toolResult content", () => {
      const w = 80;
      wrapOverride = () => ["X".repeat(w + 50)];

      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "output" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from user message content", () => {
      const w = 80;
      wrapOverride = () => ["Y".repeat(w + 100)];

      const messages = [{ role: "user", content: "hello" }];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from assistant message content", () => {
      const w = 80;
      wrapOverride = () => ["Z".repeat(w + 100)];

      const messages = [
        { role: "assistant", content: [{ type: "text", text: "response" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from bashExecution output", () => {
      const w = 80;
      wrapOverride = () => ["B".repeat(w + 100)];

      const messages = [
        {
          role: "bashExecution", command: "ls", output: "out",
          exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now(),
        },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines that also contain ANSI codes", () => {
      const w = 80;
      wrapOverride = () => [`\x1b[1m\x1b[31m${"W".repeat(w + 30)}\x1b[0m`];

      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "output" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });
  });

  describe("stop key", () => {
    const W = 80;

    it("two-press x stops a running agent (first arms, second aborts)", () => {
      const onStop = vi.fn();
      const tui = mockTui(30, W);
      const viewer = new ConversationViewer(
        tui, mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(), onStop,
      );

      // Idle footer offers the stop affordance.
      expect(viewer.render(W).join("\n")).toContain("x stop");

      // First press arms (no abort yet) and re-renders.
      viewer.handleInput("x");
      expect(onStop).not.toHaveBeenCalled();
      expect(tui.requestRender).toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).toContain("x again to STOP");

      // Second press aborts.
      viewer.handleInput("x");
      expect(onStop).toHaveBeenCalledTimes(1);
    });

    it("any other key disarms the confirm", () => {
      const onStop = vi.fn();
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(), onStop,
      );

      viewer.handleInput("x");                       // arm
      viewer.handleInput("j");                       // scroll → disarm
      expect(viewer.render(W).join("\n")).toContain("x stop");
      expect(viewer.render(W).join("\n")).not.toContain("x again to STOP");

      viewer.handleInput("x");                       // arms again, does NOT stop
      expect(onStop).not.toHaveBeenCalled();
    });

    it("does not offer or perform stop once the agent is no longer running", () => {
      const onStop = vi.fn();
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(), onStop,
      );

      expect(viewer.render(W).join("\n")).not.toContain("x stop");
      viewer.handleInput("x");
      viewer.handleInput("x");
      expect(onStop).not.toHaveBeenCalled();
    });

    it("no stop affordance when no onStop handler is provided (read-only history)", () => {
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(),
      );
      expect(viewer.render(W).join("\n")).not.toContain("x stop");
      expect(() => { viewer.handleInput("x"); viewer.handleInput("x"); }).not.toThrow();
    });
  });

  describe("steer composer", () => {
    const W = 80;

    function makeViewer(opts: { status?: AgentRecord["status"]; onSteer?: (m: string) => void } = {}) {
      const onSteer = opts.onSteer ?? vi.fn();
      const tui = mockTui(30, W);
      const viewer = new ConversationViewer(
        tui, mockSession(), mockRecord({ status: opts.status ?? "running" }),
        undefined, ansiTheme(), vi.fn(), undefined, undefined, onSteer,
      );
      return { viewer, tui, onSteer };
    }

    it("offers the steer affordance for a running agent and opens on Enter", () => {
      const { viewer } = makeViewer();
      expect(viewer.render(W).join("\n")).toContain("Enter steer");

      viewer.handleInput("\r"); // Enter
      // Composer is shown (its prompt + send/cancel hint), idle footer is gone.
      const out = viewer.render(W).join("\n");
      expect(out).toContain("Enter send · Esc cancel");
      expect(out).not.toContain("Enter steer");
    });

    it("typing then Enter sends the trimmed message and closes the composer", () => {
      const { viewer, onSteer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      for (const ch of "  hello  ") viewer.handleInput(ch);
      viewer.handleInput("\r"); // send

      expect(onSteer).toHaveBeenCalledWith("hello");
      expect(viewer.render(W).join("\n")).not.toContain("Enter send"); // composer closed
    });

    it("Esc cancels the composer without sending", () => {
      const { viewer, onSteer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      for (const ch of "draft") viewer.handleInput(ch);
      viewer.handleInput("\x1b"); // Esc

      expect(onSteer).not.toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).not.toContain("Enter send");
    });

    it("an empty submit just returns (like Esc), without calling onSteer", () => {
      const { viewer, onSteer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      viewer.handleInput("\r"); // empty submit
      expect(onSteer).not.toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).not.toContain("Enter send"); // composer closed
    });

    it("scroll keys are inert while composing (input owns them)", () => {
      const { viewer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      // 'j' would normally scroll, but here it types into the composer.
      viewer.handleInput("j");
      expect(viewer.render(W).join("\n")).toContain("Enter send · Esc cancel");
    });

    it("no steer affordance once the agent is no longer running", () => {
      const { viewer, onSteer } = makeViewer({ status: "completed" });
      expect(viewer.render(W).join("\n")).not.toContain("Enter steer");
      viewer.handleInput("\r");
      expect(viewer.render(W).join("\n")).not.toContain("Enter send");
      expect(onSteer).not.toHaveBeenCalled();
    });

    it("no steer affordance when no onSteer handler is provided", () => {
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(),
      );
      expect(viewer.render(W).join("\n")).not.toContain("Enter steer");
      expect(() => viewer.handleInput("\r")).not.toThrow();
    });

    it("composer rows never exceed width", () => {
      for (const w of [40, 80, 120]) {
        const tui = mockTui(30, w);
        const viewer = new ConversationViewer(
          tui, mockSession(), mockRecord({ status: "running" }),
          undefined, ansiTheme(), vi.fn(), undefined, undefined, vi.fn(),
        );
        viewer.handleInput("\r"); // open composer
        for (const ch of "x".repeat(200)) viewer.handleInput(ch);
        assertAllLinesFit(viewer.render(w), w);
      }
    });
  });
});

describe("ConversationViewer thinking", () => {
  const tagTheme = { fg: (c: string, t: string) => `<${c}>${t}`, bold: (t: string) => t } as any;
  const idle = () => ({ activeTools: new Map(), toolUses: 0, turnCount: 1, responseText: "" }) as any;
  const thinkingMsg = (thinking: string, text = "") => ({
    role: "assistant",
    content: [{ type: "thinking", thinking }, ...(text ? [{ type: "text", text }] : [])],
  });

  function viewerFor(opts: {
    messages?: any[]; streaming?: any; hideThinking?: boolean; activity?: any; tui?: any; mode?: "off" | "assistant";
  } = {}) {
    const session = { ...mockSession(opts.messages ?? [{ role: "user", content: "go" }]), state: { streamingMessage: opts.streaming } };
    return new ConversationViewer(
      opts.tui ?? mockTui(200, 80), session, mockRecord({ status: "running" }), opts.activity ?? idle(),
      tagTheme, vi.fn(), undefined, undefined, undefined, false, opts.mode ? () => opts.mode! : undefined,
      undefined, undefined, false, opts.hideThinking ?? false,
    );
  }
  const content = (viewer: any): string => (viewer.buildContentLines(76) as string[]).join("\n");

  it("streams the in-flight message's thinking, styled as thinking", () => {
    const out = content(viewerFor({ streaming: thinkingMsg("weighing the options") }));
    expect(out).toContain("[Assistant]");
    expect(out).toMatch(/<thinkingText>.*weighing the options/);
  });

  it("styles thinking the same on the literal path", () => {
    const out = content(viewerFor({ streaming: thinkingMsg("weighing the options"), mode: "off" }));
    expect(out).toContain("\x1b[3m<thinkingText>weighing the options\x1b[23m");
  });

  it("keeps a finished message's thinking ahead of its text", () => {
    const out = content(viewerFor({ messages: [thinkingMsg("plan first", "the answer")] }));
    expect(out.indexOf("plan first")).toBeGreaterThan(-1);
    expect(out.indexOf("plan first")).toBeLessThan(out.indexOf("the answer"));
  });

  it("shows no thinking text when pi hides thinking blocks", () => {
    const out = content(viewerFor({
      messages: [thinkingMsg("finished secret", "the answer")], streaming: thinkingMsg("live secret"), hideThinking: true,
    }));
    expect(out).not.toContain("secret");
    expect(out).toContain("the answer");
    expect(out).toContain("<muted>Thinking");
  });

  it("shows the spinner and Thinking while no text has streamed yet", () => {
    const lines = (viewerFor({ streaming: thinkingMsg("hmm") }) as any).buildContentLines(76) as string[];
    expect(lines.at(-1)).toMatch(/^<accent>[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] <muted>Thinking$/);
  });

  it("drops the indicator once response text streams, and renders that text", () => {
    const out = content(viewerFor({ streaming: thinkingMsg("hmm", "partial answer") }));
    expect(out).toContain("partial answer");
    expect(out).not.toContain("Thinking");
  });

  it("shows the tool activity line rather than Thinking while a tool runs", () => {
    const activity = { ...idle(), activeTools: new Map([["k", "read"]]) };
    const out = content(viewerFor({ activity }));
    expect(out).toContain("reading…");
    expect(out).not.toContain("Thinking");
  });

  it("reuses the transcript on a spinner frame, redrawing only the indicator", () => {
    vi.useFakeTimers();
    try {
      const viewer = viewerFor({ messages: [{ role: "assistant", content: [{ type: "text", text: "# Done" }] }], streaming: thinkingMsg("hmm") });
      viewer.render(80); // starts the spinner ticker; inner width is 76
      const first = (viewer as any).buildContentLines(76) as string[];
      markdownRenderCalls = 0;

      vi.advanceTimersByTime(80);
      const next = (viewer as any).buildContentLines(76) as string[];

      expect(markdownRenderCalls).toBe(0);
      expect(next.at(-1)).not.toBe(first.at(-1));
      expect(next.slice(0, -1)).toEqual(first.slice(0, -1));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the cached transcript until a session event says it changed", () => {
    const streaming = thinkingMsg("first thought");
    const viewer = viewerFor({ streaming });
    expect(content(viewer)).toContain("first thought");

    streaming.content[0].thinking = "second thought";
    expect(content(viewer)).toContain("first thought");

    (viewer as any).session.emit();
    expect(content(viewer)).toContain("second thought");
  });

  it("rebuilds for a new width without a session event", () => {
    const viewer = viewerFor({ messages: [{ role: "user", content: "word ".repeat(40) }] });
    const wide = (viewer as any).buildContentLines(76) as string[];
    const narrow = (viewer as any).buildContentLines(30) as string[];

    expect(narrow.length).toBeGreaterThan(wide.length);
    for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
  });

  it("animates the spinner at 80ms while thinking, and stops once text streams", () => {
    vi.useFakeTimers();
    try {
      const tui = mockTui(200, 80);
      const streaming = thinkingMsg("hmm");
      const viewer = viewerFor({ tui, streaming });
      viewer.render(80);
      tui.requestRender.mockClear();
      vi.advanceTimersByTime(800);
      expect(tui.requestRender).toHaveBeenCalledTimes(10);

      streaming.content.push({ type: "text", text: "answer" } as any);
      emit(viewer);
      viewer.render(80);
      tui.requestRender.mockClear();
      vi.advanceTimersByTime(800);
      expect(tui.requestRender).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
