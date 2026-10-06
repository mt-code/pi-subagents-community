/**
 * mention-clone.ts — start a mentioned agent through a clone of this
 * conversation, without putting anything in the chat.
 *
 * Claude Code routes `@agent-<type>` through the main model: the mention
 * becomes a `<system-reminder>` appended to the prompt and the model makes the
 * tool call (see `agentMentionReminder`). That buys the spawned agent a prompt
 * written with conversation context, and costs a visible turn — the model's
 * reasoning and its tool block land in the transcript, for a decision the user
 * already made when they typed the handle.
 *
 * So the turn happens somewhere else. The conversation is cloned into a
 * throwaway in-memory session — same messages, same system prompt, same model —
 * and that copy takes the turn off-screen. A literal clone: the session's own
 * entries, seeded into `SessionManager.inMemory` and branched to the same leaf,
 * not `inherit_context`'s text rendering of them. Since Pi 0.87 the session
 * manager is what every request is built from, so it is also the only way in;
 * pi's own projection then applies compaction and branch summaries, and a long
 * conversation clones as what the main model is actually working from.
 *
 * Cloned from memory rather than from the session file, which cannot be relied
 * on: `SessionManager._persist` withholds every write until the first assistant
 * message lands, so a fork taken before then reads an empty file and throws.
 * `getEntries()` has no such timing. A conversation with nothing in it yet
 * clones to nothing in it yet, which is the correct answer rather than a
 * failure.
 *
 * The thinking level comes from `ctx.thinkingLevel`, never from the entries:
 * those start at "off" and move only on an explicit `thinking_level_change`, so
 * a session where nobody ran `/think` would report "off" rather than the level
 * it is really using. Omitting the field instead lets `createAgentSession`
 * resolve it from settings, which is that real level.
 *
 * Three details make the spawn belong to the real session rather than the
 * clone:
 *
 *   - the clone is handed the *registered* `Agent` tool, whose handler closes
 *     over the main activation, so it spawns top-level: widget, fleet row,
 *     handle, completion notification, all as if the main model had called it;
 *   - that tool is re-bound to the main `ExtensionContext` (as a tool context:
 *     the call's own `tools` and `executeTool` ride along), because the handler
 *     reads `cwd`, `model` and `sessionManager.getSessionId()` off it to place
 *     the transcript and the `rootSessionId`. The clone's own context would
 *     file both under the throwaway fork;
 *   - it is called with no tool-call id. The clone's turn produces one, but the
 *     real session never issued it, and a `<tool-use-id>` pointing at nothing
 *     is exactly the bug the mention-resume path had to fix;
 *   - and it is forced into the background. A foreground agent returns its
 *     answer as the tool result and is marked `resultConsumed` so no completion
 *     notification is sent — correct when the caller is the real conversation,
 *     silent loss when the caller is a fork about to be discarded. Background
 *     delivery is the only route from a mention back to the main model.
 *
 * The clone gets one tool and one job. It cannot read, write or run anything —
 * an invisible turn with the full toolset could do invisible work.
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  type ExtensionToolContext,
  getAgentDir,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { runInChildSessionContext } from "./child-context.js";
import { agentMentionReminder } from "./mention.js";
import type { SubagentType } from "./types.js";

export interface MentionCloneOptions {
  /** The MAIN session's context — what the spawn is attributed to, and the
   * source of both the conversation and the live system prompt. */
  ctx: ExtensionContext;
  /** Agent type the handle resolved to. */
  type: SubagentType;
  /** What the user typed after the handle. */
  message: string;
  /** The registered `Agent` tool, reused so the spawn is an ordinary one. */
  agentTool: ToolDefinition;
}

export interface MentionCloneResult {
  /** True once the clone actually called `Agent`. */
  spawned: boolean;
  /** Why not, when it didn't. Absent on success. */
  error?: string;
}

/**
 * Fork the conversation, let the copy make the tool call, throw the copy away.
 * Never rejects: a clone that cannot run is reported so the caller can fall
 * back to starting the agent directly.
 */
export async function runMentionClone(opts: MentionCloneOptions): Promise<MentionCloneResult> {
  const { ctx, type, message, agentTool } = opts;

  let spawned = false;
  const cloneAgentTool: ToolDefinition = {
    ...agentTool,
    execute: (_cloneToolCallId, params, signal, onUpdate, cloneCtx) => {
      // One spawn per mention. The clone has a single tool and every reason to
      // stop after using it, but a model that decides to "also" launch a second
      // agent would do it where nobody can see and nobody asked.
      if (spawned) {
        return Promise.resolve({
          content: [{ type: "text" as const, text: "Already started an agent for this mention. Stop here." }],
          details: undefined,
          isError: true,
        });
      }
      spawned = true;
      // The main ctx, as a tool context: its own descriptors (pi's idiom, which
      // keeps the guarded getters lazy) plus the clone call's `tools` and
      // `executeTool` — the only two members a tool context adds.
      const mainToolCtx = Object.defineProperties(
        Object.defineProperties({}, Object.getOwnPropertyDescriptors(ctx)),
        {
          tools: { get: () => cloneCtx.tools },
          executeTool: { value: cloneCtx.executeTool },
        },
      ) as ExtensionToolContext;
      // undefined tool-call id + the main ctx: see the header. Background is
      // forced rather than left to the clone: `run_in_background` defaults to
      // false, and a foreground agent answers through its TOOL RESULT — which
      // here is delivered into a session that is disposed moments later, so the
      // agent would run, appear in the widget and the fleet, and reach nobody.
      return agentTool.execute(
        undefined as never,
        { ...(params as Record<string, unknown>), run_in_background: true } as typeof params,
        signal,
        onUpdate,
        mainToolCtx,
      );
    },
  };

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    // createAgentSession takes a ModelRuntime, and ExtensionContext exposes
    // only the ModelRegistry facade over it — the runtime is a private field
    // with no public accessor, so it is read through a cast. agent-runner.ts
    // does the same. Without it the clone would lose the parent's providers.
    const parentModelRuntime = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
    // The conversation itself: the main session's own entries, on its own
    // leaf. Pi builds provider context from the session manager, so this is
    // the only way in — and the projection is pi's, compaction and branch
    // summaries included. Nothing about the copy is worth persisting, and an
    // in-memory manager is also what keeps the real session untouched.
    const sessionManager = SessionManager.inMemory(ctx.cwd, undefined, ctx.sessionManager.getEntries());
    const leafId = ctx.sessionManager.getLeafId();
    if (leafId) sessionManager.branch(leafId);
    // The clone would rebuild a system prompt from cwd and agentDir, which is
    // close but not the live one — extensions contribute to it per turn. Use
    // the real thing, so the copy reasons under the instructions the user's
    // model is actually working under. Pi's way to send an exact prompt is a
    // `before_agent_start` result: providers receive it as the leading system
    // prompt, with the current tools, and the transcript is left alone. Inline
    // factories load after discovered extensions, so this handler runs last
    // and its prompt is the one sent. Otherwise this is the loader
    // createAgentSession would build itself.
    const systemPrompt = ctx.getSystemPrompt?.();
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(ctx.cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      settingsManager,
      extensionFactories: systemPrompt
        ? [(pi) => void pi.on("before_agent_start", () => ({ systemPrompt }))]
        : [],
    });
    const thinkingLevel = ctx.thinkingLevel;
    const created = await runInChildSessionContext(async () => {
      await resourceLoader.reload();
      return createAgentSession({
        cwd: ctx.cwd,
        agentDir,
        sessionManager,
        settingsManager,
        resourceLoader,
        model: ctx.model,
        ...(thinkingLevel && { thinkingLevel }),
        ...(parentModelRuntime && { modelRuntime: parentModelRuntime }),
        // An allowlist naming exactly the clone's own tool. NOT `noTools:
        // "all"`, whose doc comment ("start with no tools enabled") reads like
        // it spares custom tools and does not: it resolves to an EMPTY
        // allowlist, and `isAllowedTool` then drops every tool from the
        // registry — the custom one included. The clone would be prompted with
        // nothing to call, answer in prose, and every mention would fall
        // through to the direct start with a warning. Same idiom as
        // agent-runner's `tools: sessionTools` beside its nested `customTools`.
        tools: [cloneAgentTool.name],
        customTools: [cloneAgentTool],
      });
    });
    session = created.session;

    // User text first, reminder after — the order Claude Code's attachment
    // renderer produces, where the reminder trails the message it is about.
    await session.prompt(`${message}\n\n${agentMentionReminder(type)}`);
  } catch (err) {
    return { spawned, error: err instanceof Error ? err.message : String(err) };
  } finally {
    session?.dispose?.();
  }

  return spawned
    ? { spawned: true }
    : { spawned: false, error: "the conversation clone did not start it" };
}
