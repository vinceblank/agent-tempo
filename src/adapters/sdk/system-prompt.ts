/**
 * Shared SDK-class adapter system-prompt helpers (#536).
 *
 * Two SDK-class adapters in this repo currently mirror an *identical*
 * "use your MCP tools to reply" framing onto the model — copilot
 * (`src/adapters/copilot/adapter.ts:283-297`) and, post-#536,
 * claude-code-headless (`src/adapters/claude-code-headless/adapter.ts`).
 * Pre-#536 the framing only existed on copilot's side, hand-typed
 * inline; this module factors it out so:
 *
 *   - There is one canonical source for the prompt content (no copy
 *     drift when someone tweaks the wording in one place and forgets
 *     the other).
 *   - The MAESTRO_ACK augmentation that copilot's poll loop applies
 *     to human-from-dashboard messages is identifiable by name from
 *     either adapter's prompt-build site.
 *
 * **Why not `buildServerInstructions` from `src/server-tools.ts`?**
 * The other two SDK-class adapters (claude-api, opencode) DO use
 * `buildServerInstructions` for their per-turn system prompt. Copilot
 * predates that helper and ships its own inline framing with a more
 * explicit "tools available" enumeration. Issue #536 directs
 * claude-code-headless to mirror **copilot's** content (so the two
 * adapters speak the same dialect to the model), not the canonical
 * helper. A future consolidation pass could migrate ALL four SDK
 * adapters onto `buildServerInstructions` — out of scope here.
 */

/**
 * SDK-class adapter system-prompt template, parameterized by ensemble.
 *
 * Lifted verbatim from `src/adapters/copilot/adapter.ts:283-297` (the
 * pre-#536 inline `systemMessage.content`). Both copilot and
 * claude-code-headless feed this into their per-turn invocation:
 *   - copilot via `sessionConfig.systemMessage` to the SDK's
 *     `createSession` call.
 *   - claude-code-headless via `--append-system-prompt <content>` on
 *     the per-turn `claude -p` argv.
 *
 * Returning a function (rather than a constant) preserves the
 * `${ensemble}` interpolation hook — different ensembles see different
 * names without templating in the call site.
 *
 * @param opts.ensemble Ensemble name shown to the model in the first
 *   line ("You are part of the …"). Pass `config.ensemble`.
 */
export function buildSdkSystemPrompt(opts: { ensemble: string }): string {
  return (
    `You are part of the "${opts.ensemble}" ensemble coordinated via Temporal. ` +
    `You have MCP tools available — ALWAYS use these tools directly, NEVER try to run them as shell commands:\n` +
    `- set_name: Set your player name (call this FIRST if instructed)\n` +
    `- ensemble: List active sessions\n` +
    `- cue: Send a message to another player\n` +
    `- set_part: Update your status/description\n` +
    `- listen: Check for pending messages\n` +
    `- recruit: Spawn a new player session\n` +
    `- report: Report to the conductor\n` +
    `- stop: Stop a session\n\n` +
    `When you receive a message from another session, treat it like a coworker asking for help — respond promptly using your MCP tools.`
  );
}

/**
 * Per-message augmentation appended to messages whose `isMaestro`
 * field is `true`. The maestro flag identifies messages originating
 * from a human operator at the dashboard (vs. ensemble-internal
 * cues from other player sessions).
 *
 * Lifted verbatim from `src/adapters/copilot/adapter.ts:462`. Both
 * copilot's poll-loop prompt-build and claude-code-headless's
 * per-turn `buildPromptText` apply this conditionally per
 * `m.isMaestro` — a human-from-dashboard message gets the ack
 * directive; an ensemble-internal cue does not.
 *
 * The leading `\n\n` separates the directive from the human's
 * message text inside the same prompt frame.
 */
export const MAESTRO_ACK =
  '\n\n[IMPORTANT: This message is from a human (Maestro). Immediately cue the sender back with a brief acknowledgment and your planned next step before doing the work.]';
