/**
 * render-invariants.perf.test.ts — the shape of the render paths, asserted as
 * operation counts rather than as time.
 *
 * These run in the normal suite, which means they run three times per CI push
 * (build, floor-Pi, latest-Pi) on shared runners. A wall-clock threshold there
 * would be a flake generator: two runs of identical code in this repo differed
 * by 7% on ordering alone. So nothing here is timed. Counting how many times a
 * render reaches a leaf is deterministic, costs milliseconds, and catches the
 * regression that actually hurts — work that stops being linear, or a frame
 * that starts touching the disk.
 *
 * Absolute numbers live in `test/perf/*.bench.ts`, where a human reads them.
 *
 * Every bound here is an upper bound, never an equality: making one of these
 * paths cheaper must not turn a test red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Counters for the pi-tui leaves the viewer wraps its text with. */
const counts = { wrap: 0, markdownNew: 0, markdownRender: 0 };

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  class CountingMarkdown extends (actual.Markdown as any) {
    constructor(...args: any[]) {
      super(...args);
      counts.markdownNew++;
    }
    render(...args: any[]) {
      counts.markdownRender++;
      return super.render(...args);
    }
  }
  return {
    ...actual,
    Markdown: CountingMarkdown,
    wrapTextWithAnsi: (...args: [string, number]) => {
      counts.wrap++;
      return actual.wrapTextWithAnsi(...args);
    },
  };
});

// After the mock, so the subjects bind the counting versions.
const { AgentWidget } = await import("../../src/ui/agent-widget.js");
const { ConversationViewer } = await import("../../src/ui/conversation-viewer.js");
const { makeActivity, makeFleet, makeRecord, makeSession, makeStreamingSession, makeToolStreamingSession, mountViewer, NOW, perfTheme, perfTui } = await import(
  "../helpers/perf-fixtures.js"
);

beforeEach(() => {
  counts.wrap = 0;
  counts.markdownNew = 0;
  counts.markdownRender = 0;
});

describe("ConversationViewer — cost stays linear in transcript length", () => {
  /**
   * Leaf calls one render makes over a transcript of `n` messages after a
   * session event — the rebuild every streamed token pays. Without the event
   * the cached transcript is reused and the render does no leaf work at all.
   */
  function wrapsFor(n: number, mode: string, session = makeSession(n)): number {
    const viewer = mountViewer(ConversationViewer, session, undefined, () => mode);
    viewer.render(120); // prime, so caches are warm and only steady state counts
    session.emit();
    counts.wrap = 0;
    counts.markdownRender = 0;
    viewer.render(120);
    return counts.wrap + counts.markdownRender;
  }

  // A session event drops the transcript, but finished messages keep their
  // rendered lines: only what can still change is rebuilt. Without that, every
  // event re-wraps the whole history, and a bash call streaming an update every
  // 100 ms over a long transcript outpaces the render and stalls the TUI.
  it("an event re-renders no finished message (raw wrap path)", () => {
    expect(wrapsFor(300, "off")).toBe(0);
  });

  it("an event re-renders no finished message (markdown path)", () => {
    expect(wrapsFor(300, "assistant")).toBe(0);
  });

  it("a streamed tool update re-wraps the running call, whatever the transcript's length", () => {
    const wrapsPerUpdate = (n: number): number => {
      const session = makeToolStreamingSession(n);
      const record = makeRecord(0, { toolTimings: new Map([["live", { startedAt: NOW }]]) });
      const viewer = mountViewer(ConversationViewer, session, record, () => "assistant");
      viewer.render(120);
      session.update(0);
      counts.wrap = 0;
      counts.markdownRender = 0;
      viewer.render(120);
      return counts.wrap + counts.markdownRender;
    };

    const small = wrapsPerUpdate(30);
    expect(small).toBeGreaterThan(0);
    expect(wrapsPerUpdate(300)).toBeLessThanOrEqual(small);
  });

  it("does ~10x the work for 10x the messages while a thinking block streams", () => {
    const small = wrapsFor(30, "assistant", makeStreamingSession(30, { thinkingChars: 2_000 }));
    const large = wrapsFor(300, "assistant", makeStreamingSession(300, { thinkingChars: 2_000 }));

    expect(small).toBeGreaterThan(0);
    expect(large / small).toBeLessThanOrEqual(11);
  });

  // The Thinking spinner redraws every 80 ms. If a frame with no session event
  // rebuilt the transcript, a thinking agent with 5000 messages would hold a
  // core for as long as it thinks.
  it("a frame with no session event does no transcript work", () => {
    const activity = { activeTools: new Map(), toolUses: 0, turnCount: 1, responseText: "" };
    const viewer = mountViewer(ConversationViewer, makeStreamingSession(300, { thinkingChars: 2_000 }), undefined, () => "assistant", undefined, { activity });
    viewer.render(120);
    counts.wrap = 0;
    counts.markdownRender = 0;

    viewer.render(120);
    viewer.render(120);

    expect(counts.wrap + counts.markdownRender).toBe(0);
  });

  it("a streamed thinking delta re-parses its block rather than building a new one", () => {
    const session = makeStreamingSession(30, { thinkingChars: 2_000 });
    const viewer = mountViewer(ConversationViewer, session, undefined, () => "assistant");
    viewer.render(120);
    const afterFirst = counts.markdownNew;

    for (let i = 0; i < 10; i++) {
      session.delta(i);
      session.emit();
      viewer.render(120);
    }

    expect(counts.markdownNew).toBe(afterFirst);
  });

  it("hidden thinking builds no Markdown for the thinking block", () => {
    const built = (session: any, hideThinking: boolean) => {
      counts.markdownNew = 0;
      mountViewer(ConversationViewer, session, undefined, () => "assistant", undefined, { hideThinking }).render(120);
      return counts.markdownNew;
    };

    expect(built(makeStreamingSession(30, { thinkingChars: 100_000 }), true))
      .toBeLessThanOrEqual(built(makeStreamingSession(30, {}), false));
  });

  // #259's WeakMap is keyed by the message object. If a refactor ever rebuilds
  // messages, or keys the cache on something that changes per frame, every frame
  // re-parses the whole transcript as Markdown — a cost this suite measured at
  // roughly 10x the warm path. Nothing else in the suite would notice.
  it("re-renders without re-parsing: the markdown cache survives a frame", () => {
    const viewer = mountViewer(ConversationViewer, makeSession(60), undefined, () => "assistant");
    viewer.render(120);
    const afterFirst = counts.markdownNew;
    expect(afterFirst).toBeGreaterThan(0);

    viewer.render(120);
    viewer.render(120);

    expect(counts.markdownNew).toBe(afterFirst);
  });
});

describe("AgentWidget — one frame does not rescan per agent", () => {
  /** Renders one frame over `n` agents; returns how often the manager was asked. */
  function listCallsPerRender(n: number): number {
    const records = makeFleet({ running: n });
    let listAgentsCalls = 0;
    const manager = {
      listAgents: () => {
        listAgentsCalls++;
        return records;
      },
    } as any;

    const widget = new AgentWidget(manager, makeActivity(records), () => "all", () => false, () => false);
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k: string, c: any) => { factory = c; } } as any);
    widget.update();
    const tui = perfTui();
    factory?.(tui, perfTheme).render(); // prime
    listAgentsCalls = 0;
    factory?.(tui, perfTheme).render();
    widget.dispose?.();
    return listAgentsCalls;
  }

  // Today a render is exactly one scan (`update()` does the other). The bound is
  // "a constant, and the same constant at 100 agents as at 1" — a per-agent
  // lookup added to the row builder would break it, and collapsing the two
  // remaining scans into one would not.
  it("asks the manager for the agent list a constant number of times", () => {
    expect(listCallsPerRender(1)).toBeLessThanOrEqual(2);
    expect(listCallsPerRender(100)).toBeLessThanOrEqual(2);
    expect(listCallsPerRender(100)).toBe(listCallsPerRender(1));
  });
});
