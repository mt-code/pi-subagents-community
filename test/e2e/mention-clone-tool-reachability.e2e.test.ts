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
 * No network/LLM: a scripted provider also checks the live prompt and seeded
 * history at the request boundary, where Pi projects them from session entries.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
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
    const main = SessionManager.inMemory(cwd);
    main.appendMessage({ role: "user", content: "COMPACTED-AWAY", timestamp: 1 });
    const retainedId = main.appendMessage({ role: "user", content: "MAIN-HISTORY", timestamp: 2 });
    main.appendCompaction("MAIN-SUMMARY", retainedId, 100);
    main.appendContextEdit(retainedId, { content: "EDITED-HISTORY" });
    const mainBranch = structuredClone(main.getBranch());
    const prompts: string[] = [];
    const tools: string[][] = [];
    const histories: string[] = [];
    faux.setResponses([
      context => {
        prompts.push(getCurrentSystemPrompt(context.messages));
        tools.push(getCurrentTools(context.messages).map(tool => tool.name));
        histories.push(JSON.stringify(context.messages));
        return fauxAssistantMessage(fauxToolCall("Agent", {}));
      },
      fauxAssistantMessage("done"),
    ]);
    const ctx: any = {
      cwd,
      model,
      getSystemPrompt: () => "PARENT",
      // mention-clone reads the runtime off the registry facade, the same shim
      // agent-runner carries for Pi >= 0.80.8.
      modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
      sessionManager: main,
    };

    const agentTool = {
      name: "Agent", label: "Agent", description: "Start a child", parameters: Type.Object({}),
      execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "spawned" }], details: undefined })),
    };
    const result = await runMentionClone({ ctx, type: "Explore", message: "go", agentTool });

    expect(sessions).toHaveLength(1);
    // The bug this file exists for: with an empty allowlist this is `[]`.
    expect(sessions[0].getActiveToolNames()).toEqual(["Agent"]);
    expect(result).toEqual({ spawned: true });
    expect(prompts).toEqual(["PARENT"]);
    expect(tools).toEqual([["Agent"]]);
    expect(histories[0]).toContain("MAIN-SUMMARY");
    expect(histories[0]).toContain("EDITED-HISTORY");
    expect(histories[0]).not.toContain("COMPACTED-AWAY");
    expect(histories[0]).not.toContain("MAIN-HISTORY");
    expect(agentTool.execute).toHaveBeenCalledOnce();
    expect(main.getBranch()).toEqual(mainBranch);
  });
});
