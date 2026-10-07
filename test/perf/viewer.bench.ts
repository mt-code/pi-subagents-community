/**
 * viewer.bench.ts — `ConversationViewer.render()` against transcripts of
 * growing size.
 *
 * The highest-value benchmark in the repo: this is the only frame-rate path
 * whose cost is unbounded in the data it renders. The viewer caches the built
 * transcript, but every session event drops it, so a running agent rebuilds the
 * *entire* transcript on every token (coalesced by pi at ~62 Hz). Everything
 * above the viewport is built and thrown away. The warm benches below emit an
 * event before each render to measure that rebuild; the spinner bench measures
 * the frame that reuses it.
 *
 * Both markdown modes are measured. `assistant` is the default and sends
 * assistant text through pi's Markdown parser; `off` is the raw wrap path. The
 * pair is the cost of #259, and the cap it introduced (RESULT_MAX_CHARS) is what
 * keeps a single large tool result from dominating the whole frame.
 *
 * Cold vs warm is the other axis worth knowing: the Markdown cache is a WeakMap
 * keyed by the message object, so the first frame parses and later frames reuse.
 * A regression that breaks cache identity would leave "warm" looking like
 * "cold" here while every other test stays green.
 */
import { bench, describe } from "vitest";
import { ConversationViewer } from "../../src/ui/conversation-viewer.js";
import { makeSession, makeStreamingSession, mountViewer, styledPerfTheme } from "../helpers/perf-fixtures.js";

const SIZES = [50, 500, 5000];

describe("ConversationViewer.render — markdown: assistant (default)", () => {
  for (const n of SIZES) {
    const session = makeSession(n);
    const viewer = mountViewer(ConversationViewer, session);
    viewer.render(120); // prime: first frame parses, the measured ones reuse
    bench(`${n} messages`, () => {
      session.emit();
      viewer.render(120);
    });
  }
});

// The identity theme above leaves every line plain ASCII, which is the cheapest
// case for width measurement and truncation. Pi's theme wraps each line in
// escapes, and those take the slow route — so this is the number a user sees.
describe("ConversationViewer.render — markdown: assistant, styled theme", () => {
  for (const n of SIZES) {
    const session = makeSession(n);
    const viewer = mountViewer(ConversationViewer, session, undefined, undefined, styledPerfTheme);
    viewer.render(120);
    bench(`${n} messages`, () => {
      session.emit();
      viewer.render(120);
    });
  }
});

describe("ConversationViewer.render — markdown: off (raw wrap)", () => {
  for (const n of SIZES) {
    const session = makeSession(n);
    const viewer = mountViewer(ConversationViewer, session, undefined, () => "off");
    viewer.render(120);
    bench(`${n} messages`, () => {
      session.emit();
      viewer.render(120);
    });
  }
});

describe("ConversationViewer.render — cold cache (first frame)", () => {
  // What a viewer costs the moment it is opened on an agent that already has
  // history: every sample renders a viewer that has never rendered, so the
  // Markdown cache starts empty and every message is parsed from scratch.
  //
  // Building those viewers is NOT part of the measurement — `makeSession(500)`
  // allocates 500 message objects and their text, which timed inline would be
  // charged to the render. They are built up front, into a pool sized to the
  // exact number of samples, and each sample takes the next one.
  //
  // A pool rather than tinybench's `beforeEach`, because vitest never gives
  // tinybench a chance to run it: `runBenchmarkSuite` constructs
  // `new Task(bench, name, fn)` with three arguments and drops the fourth
  // options object entirely, so per-task hooks are silently ignored. Bench-level
  // options (`time`, `iterations`) do survive — they go through `new Bench(...)`.
  // A hook-based version of this ran zero samples and reported "NaNx faster".
  const WARMUP = 2;
  const SAMPLES = { 50: 40, 500: 12 } as Record<number, number>;

  for (const n of [50, 500]) {
    const iterations = SAMPLES[n];
    const pool = Array.from({ length: iterations + WARMUP }, () =>
      mountViewer(ConversationViewer, makeSession(n)),
    );
    let next = 0;
    bench(
      `${n} messages`,
      () => {
        // Modulo only guards a miscount; a wrapped entry would be warm, not cold.
        pool[next++ % pool.length].render(120);
      },
      { time: 0, iterations, warmupTime: 0, warmupIterations: WARMUP },
    );
  }
});

// ---- Live streaming ----
//
// Each sample is one streamed token: change the in-flight block, fire the
// session event, render. Under `bench:ab` against a tree that predates live
// streaming, the base side never renders `state.streamingMessage`, so its number
// is the transcript rebuild alone and the delta column reads as "what live
// streaming adds per token" — not as the same work getting slower.

/** A running agent with no tool in flight: the state that shows the Thinking spinner. */
const idle = { activeTools: new Map(), toolUses: 0, turnCount: 1, responseText: "" };

function streamingBench(name: string, n: number, opts: { thinkingChars?: number; textChars?: number }, hideThinking = false) {
  const session = makeStreamingSession(n, opts);
  const viewer = mountViewer(ConversationViewer, session, undefined, undefined, undefined, { activity: idle, hideThinking });
  viewer.render(120);
  let i = 0;
  bench(name, () => {
    session.delta(i++);
    session.emit();
    viewer.render(120);
  });
}

// The in-flight block is re-parsed whole on every token, so this grows with
// the thinking so far — and a long thinking stream pays it once per token.
describe("ConversationViewer.render — streaming thinking delta, by thinking size", () => {
  for (const chars of [2_000, 20_000, 100_000]) {
    streamingBench(`${chars / 1000}k chars, 50 messages`, 50, { thinkingChars: chars });
  }
});

// The rebuild every token pays on top of the block's own parse.
describe("ConversationViewer.render — streaming thinking delta, by transcript size", () => {
  for (const n of SIZES) {
    streamingBench(`${n} messages, 2k thinking`, n, { thinkingChars: 2_000 });
  }
});

// Read against "by transcript size" at 500: hiding thinking should leave only
// the rebuild, however large the hidden block.
describe("ConversationViewer.render — streaming thinking delta, hidden", () => {
  streamingBench("500 messages, 20k thinking", 500, { thinkingChars: 20_000 }, true);
});

describe("ConversationViewer.render — streaming text delta", () => {
  streamingBench("500 messages, 2k text", 500, { textChars: 2_000 });
});

// What the 80 ms spinner costs per frame: no event, so the cached transcript is
// reused and only the indicator is built. Against a tree with no cache this
// row is a full rebuild per frame.
describe("ConversationViewer.render — spinner frame (no event)", () => {
  for (const n of SIZES) {
    const viewer = mountViewer(ConversationViewer, makeStreamingSession(n, { thinkingChars: 2_000 }), undefined, undefined, undefined, { activity: idle });
    viewer.render(120);
    bench(`${n} messages`, () => {
      viewer.render(120);
    });
  }
});
