/**
 * mention-clone-tool-reachability.e2e.test.ts — reachability guard for the one
 * tool the mention clone is built around.
 *
 * `runMentionClone` hands a session ONE tool and expects the model to call it.
 * Whether that tool ever reaches the model is decided entirely inside Pi, by
 * `createAgentSession`'s allowlist plumbing — and the unit tests cannot see it:
 * their `createAgentSession` is a mock that hands `customTools[0]` straight to
 * the model turn, so a session option that silently strips the tool passes
 * every one of them.
 *
 * That is not hypothetical. The clone shipped with `noTools: "all"` on the
 * reading its doc comment invites ("start with no tools enabled" — no
 * built-ins, keep mine). Pi turns that flag into an EMPTY allowlist, and an
 * empty array is truthy, so `AgentSession` builds an empty `Set` and
 * `isAllowedTool` rejects every name — custom tools are filtered by the same
 * predicate as built-ins. Every mention was prompted with no tools, answered in
 * prose, and fell back to a direct start with a warning. The unit suite stayed
 * green throughout.
 *
 * So this asserts against a REAL session, on the two things a mock cannot
 * establish:
 *   1. the clone's `Agent` tool is actually active on it, and
 *   2. nothing else is — the invisible turn cannot read, write or run anything.
 *
 * No network/LLM: a faux provider satisfies session construction, and the
 * assertion is on the constructed tool set rather than on a model turn.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxText,
  getCurrentSystemPrompt,
  getCurrentTools,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real pi-mono session construction; a cold first run under full-suite CPU
// contention can exceed vitest's 5s default.
vi.setConfig({ testTimeout: 30_000 });

// Hoisted so the (lifted) mock factory can reach it. Everything except the
// capture is the real module — the point is to construct a REAL session.
const { sessions } = vi.hoisted(() => ({ sessions: [] as any[] }));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<any>("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    createAgentSession: async (opts: any) => {
      const created = await actual.createAgentSession(opts);
      sessions.push(created.session);
      return created;
    },
  };
});

import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { runMentionClone } from "../../src/mention-clone.js";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

describe("mention clone tool reachability against real pi-mono", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    sessions.length = 0;
    cwd = mkdtempSync(join(tmpdir(), "subagents-mention-clone-"));
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("the clone's Agent tool is live on the real session, and it is the only one", async () => {
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const ctx: any = {
      cwd,
      model,
      getSystemPrompt: () => "PARENT",
      // mention-clone reads the runtime off the registry facade, the same shim
      // agent-runner carries for Pi >= 0.80.8.
      modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
      sessionManager: { getEntries: () => [], getLeafId: () => undefined },
    };

    // Never called: the assertion is on what the session exposes, not on the
    // faux model deciding to use it.
    const agentTool = { name: "Agent", execute: vi.fn() } as any;

    // Never rejects by contract; a faux turn that cannot complete is fine,
    // because the tool set is fixed at construction.
    await runMentionClone({ ctx, type: "Explore", message: "go", agentTool });

    expect(sessions).toHaveLength(1);
    // The bug this file exists for: with an empty allowlist this is `[]`.
    expect(sessions[0].getActiveToolNames()).toEqual(["Agent"]);
  });

  it("the clone's model sees the main conversation and the live system prompt", async () => {
    // Since pi 0.87 the session manager, not `agent.state`, is what a request
    // is built from. A clone that writes the conversation anywhere else starts
    // its turn knowing nothing, and no mocked test can tell.
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const { session: main } = await createAgentSession({
      cwd,
      sessionManager: SessionManager.inMemory(cwd),
      model,
      modelRuntime: backend.modelRuntime,
      tools: [],
    } as any);

    let seen: TranscriptContext | undefined;
    faux.setResponses([
      fauxAssistantMessage([fauxText("MAIN_REPLY")]),
      (context) => {
        seen = context;
        return fauxAssistantMessage([fauxText("not calling it")]);
      },
    ]);
    try {
      await main.prompt("MAIN_USER_TURN");
      const ctx: any = {
        cwd,
        model,
        getSystemPrompt: () => "LIVE_PROMPT_MARKER",
        modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
        sessionManager: main.sessionManager,
      };

      // A real declaration: pi round-trips every tool's schema through JSON.
      const agentTool = { name: "Agent", parameters: { type: "object", properties: {} } } as any;
      await runMentionClone({ ctx, type: "Explore", message: "MENTION_TEXT", agentTool });

      expect(seen).toBeDefined();
      const text = JSON.stringify(seen?.messages.filter((m) => m.role !== "system"));
      for (const marker of ["MAIN_USER_TURN", "MAIN_REPLY", "MENTION_TEXT"]) expect(text).toContain(marker);
      const messages = seen?.messages ?? [];
      // Exactly the live prompt: one that pi had rebuilt around it would carry
      // its own sections (a second <cwd>, the default preamble) as well.
      expect(getCurrentSystemPrompt(messages)).toBe("LIVE_PROMPT_MARKER");
      expect(getCurrentTools(messages).map((t) => t.name)).toEqual(["Agent"]);
    } finally {
      main.dispose();
    }
  });
});
