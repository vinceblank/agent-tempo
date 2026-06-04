/**
 * Shared tool-registration + instructions helpers.
 *
 * `src/server.ts` builds an MCP server backed by stdio and registers every
 * tempo tool onto it. The `claude-api` adapter (#131 Phase C) builds a
 * second MCP server backed by `InMemoryTransport` and needs the **same**
 * tool surface registered onto it. Extracting both helpers here keeps the
 * two callsites in lock-step — adding a new tool to one surface lights it
 * up on the other automatically.
 *
 * Mirrors the dual-purpose pattern used elsewhere (e.g. `src/connection.ts`
 * shared by daemon + adapter subprocesses): keep cross-surface knowledge
 * in a single module rather than letting drift accumulate.
 *
 * Design reference: `docs/design/131-claude-api-adapter.md` §4 (in-process
 * MCP bridge) — engineer pickup explicitly calls out a `registerAllTempoTools`
 * helper at line ~478.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client, WorkflowHandle } from '@temporalio/client';
import { Config } from './config';
import { AgentType } from './types';
import { renderToMcp, type TempoToolDescriptor } from './tools/descriptor';
import { buildEnsembleTool } from './tools/ensemble';
import { buildCueTool } from './tools/cue';
import { buildSetPartTool } from './tools/set-part';
import { buildListenTool } from './tools/listen';
import { buildRecruitTool } from './tools/recruit';
import { buildReportTool } from './tools/report';
import { buildSetNameTool } from './tools/set-name';
import { buildScheduleTool } from './tools/schedule';
import { buildUnscheduleTool } from './tools/unschedule';
import { buildSchedulesTool } from './tools/schedules';
import { buildSaveLineupTool } from './tools/save-lineup';
import { buildLoadLineupTool } from './tools/load-lineup';
import { buildAgentTypesTool } from './tools/agent-types';
import { buildWhoAmITool } from './tools/who-am-i';
import { buildBroadcastTool } from './tools/broadcast';
import { buildRecallTool } from './tools/recall';
import { buildReleaseTool } from './tools/release';
import { buildPauseTool } from './tools/pause';
import { buildPlayTool } from './tools/play';
import { buildShutdownTool } from './tools/shutdown';
import { buildRestoreTool } from './tools/restore';
import { buildQualityGateTool } from './tools/quality-gate';
import { buildEvaluateGateTool } from './tools/evaluate-gate';
import { buildGatesTool } from './tools/gates';
import { buildWorktreeTool } from './tools/worktree';
import { buildStageTool } from './tools/stage';
import { buildStagesTool } from './tools/stages';
import { buildCancelStageTool } from './tools/cancel-stage';
import { buildRestartTool } from './tools/restart';
import { buildDestroyTool } from './tools/destroy';
import { buildResetTool } from './tools/reset';
import { buildMigrateTool } from './tools/migrate';
import { buildAttachmentInfoTool } from './tools/attachment-info';
import { buildHostsTool } from './tools/hosts';
import { buildSetEnsembleDescriptionTool } from './tools/set-ensemble-description';
// #334 PR-1 — player saveable state (save_state / fetch_state / clear_state).
import { buildSaveStateTool } from './tools/save-state';
import { buildFetchStateTool } from './tools/fetch-state';
import { buildClearStateTool } from './tools/clear-state';
// #318 — ensemble-shared coat-check (put / get / list / evict).
import { buildCoatCheckPutTool } from './tools/coat-check-put';
import { buildCoatCheckGetTool } from './tools/coat-check-get';
import { buildCoatCheckListTool } from './tools/coat-check-list';
import { buildCoatCheckEvictTool } from './tools/coat-check-evict';

/**
 * Identity + state context every tool registration consumes. The two
 * surfaces (stdio MCP server in `src/server.ts`, in-process MCP server in
 * the claude-api adapter) build the same struct from their respective
 * boot paths and pass it to {@link registerAllTempoTools}.
 *
 * Note: `setPlayerId` is the rename hook used by `set_name`. The adapter
 * passes a no-op for headless players that don't need rename support; the
 * stdio server passes its real setter so a `set_name` call from the LLM
 * updates the in-process identity used by subsequent tool invocations.
 */
export interface RegisterAllTempoToolsOpts {
  client: Client;
  config: Config;
  /** Returns the current player id. Mutates over a session via `set_name`. */
  getPlayerId: () => string;
  /** Update the player id (drives `set_name`). Adapter callers may pass a no-op. */
  setPlayerId: (id: string) => void;
  /** Handle to the player's own session workflow. */
  handle: WorkflowHandle;
  /** Workflow id of the player's session. Forwarded to ensemble tool. */
  workflowId: string;
  /** Default agent for `recruit` when the caller doesn't override. */
  ownAgentType: AgentType;
  /** Whether this player is the ensemble's conductor (gates conductor-only tools). */
  isConductor: boolean;
}

/**
 * Register every tempo MCP tool onto `server`. Single source of truth — the
 * stdio MCP server (`src/server.ts`) and the in-process MCP server in the
 * claude-api adapter both call this with the same option struct. Adding a
 * new tool here lights it up on every surface without per-callsite drift.
 *
 * Conductor-only tools (quality gates, worktrees, stages) are gated by
 * `opts.isConductor` — non-conductor players don't see them on either
 * surface.
 */
export function buildAllTempoTools(opts: RegisterAllTempoToolsOpts): TempoToolDescriptor[] {
  const { client, config, getPlayerId, setPlayerId, handle, workflowId, ownAgentType, isConductor } = opts;

  const tools: TempoToolDescriptor[] = [
    buildEnsembleTool(client, config, getPlayerId, workflowId),
    buildCueTool(client, config, getPlayerId, handle),
    buildSetPartTool(handle),
    buildSetNameTool(client, config, handle, getPlayerId, setPlayerId),
    buildListenTool(handle),
    buildRecruitTool(client, config, getPlayerId, handle, ownAgentType),
    buildReportTool(handle),
    buildScheduleTool(client, config, getPlayerId),
    buildUnscheduleTool(client, config),
    buildSchedulesTool(client, config),
    buildSaveLineupTool(client, config, getPlayerId, isConductor),
    buildLoadLineupTool(client, config, getPlayerId, ownAgentType, handle, setPlayerId, isConductor),
    buildAgentTypesTool(),
    buildWhoAmITool(handle, getPlayerId),
    buildBroadcastTool(client, config, getPlayerId, handle),
    buildRecallTool(handle, getPlayerId),
    buildReleaseTool(client, config, getPlayerId, handle),
    buildPauseTool(client, config, getPlayerId),
    buildPlayTool(client, config, getPlayerId),
    buildShutdownTool(client, config, getPlayerId),
    buildRestoreTool(client, config, getPlayerId),
    buildRestartTool(client, config, getPlayerId, handle),
    buildDestroyTool(client, config, getPlayerId, handle),
    buildResetTool(handle, getPlayerId),
    buildMigrateTool(client, config, getPlayerId, handle),
    buildAttachmentInfoTool(client, config),
    buildHostsTool(client, config),
    buildSetEnsembleDescriptionTool(client, config),
    // #334 PR-1 — owner-write / peer-read player saveable state.
    buildSaveStateTool(handle, getPlayerId),
    buildFetchStateTool(client, config, handle, getPlayerId),
    buildClearStateTool(handle),
    // #318 — ensemble-shared coat-check (put/get/list/evict). Any player can put;
    // any player can get/list; owner-or-conductor can evict. Audit identity is
    // set at the tool layer via getPlayerId() — no playerId arg on any schema.
    buildCoatCheckPutTool(client, config, getPlayerId),
    buildCoatCheckGetTool(client, config, getPlayerId),
    buildCoatCheckListTool(client, config),
    buildCoatCheckEvictTool(client, config, getPlayerId),
  ];

  if (isConductor) {
    tools.push(
      buildQualityGateTool(handle, getPlayerId),
      buildEvaluateGateTool(handle, getPlayerId),
      buildGatesTool(handle),
      buildWorktreeTool(client, config, handle, getPlayerId),
      buildStageTool(handle, getPlayerId),
      buildStagesTool(handle),
      buildCancelStageTool(handle),
    );
  }

  return tools;
}

export function registerAllTempoTools(
  server: McpServer,
  opts: RegisterAllTempoToolsOpts,
): void {
  renderToMcp(server, buildAllTempoTools(opts));
}

/**
 * Identity + ensemble context for {@link buildServerInstructions}.
 * Same struct shape across the two callers (stdio server + claude-api
 * adapter); the latter appends a headless-only addendum after the shared
 * instructions land in the cached system prompt.
 */
export interface BuildServerInstructionsOpts {
  ensemble: string;
  playerId: string;
  playerType?: string;
  playerTypeDescription?: string;
  isConductor: boolean;
  /** Whether the player's name was set at startup (vs needing a `set_name` cue). */
  hasRequestedName: boolean;
}

/**
 * Build the `instructions` string that lands in `McpServer`'s `instructions`
 * option (or in the claude-api adapter's cached system prompt). Captures
 * identity, role, the `set_name` first-cue contract, and the conductor /
 * non-conductor operational rules around branch switches and worktree
 * provisioning.
 *
 * Verbatim port of the inline string `src/server.ts` used to build pre-#131
 * — extracted so the claude-api adapter (and any future MCP-server caller)
 * can reuse the same identity framing without copy-paste drift.
 */
export function buildServerInstructions(opts: BuildServerInstructionsOpts): string {
  const { ensemble, playerId, playerType, playerTypeDescription, isConductor, hasRequestedName } = opts;
  const playerTypeLine = playerType
    ? `Your player type is "${playerType}"${playerTypeDescription ? ` (${playerTypeDescription})` : ''}. `
    : '';
  return `You are part of the "${ensemble}" ensemble of Claude Code sessions coordinated via Temporal. ` +
    `Your player name is "${playerId}". ` +
    playerTypeLine +
    (hasRequestedName
      ? `This name was assigned at startup — do NOT call \`set_name\` unless explicitly asked to rename. `
      : `IMPORTANT: If you receive a message instructing you to call \`set_name\`, do so immediately before anything else. Use \`set_name\` to give yourself a human-readable name. `) +
    `When you receive a message from another session, treat it like a coworker asking for help — respond promptly, then resume your work. ` +
    `Use \`ensemble\` to see who else is active. ` +
    `Use \`cue\` to reply directly to the player who messaged you, or to ask others for help. ` +
    `Use \`recruit\` if you need a session in a directory where none exists. ` +
    `Use \`report\` to notify the conductor of task completion, blockers, or questions — always report when you finish a recruited task.` +
    `\n\nCommunication discipline:\n` +
    `- Drafting a response in your turn is not the same as sending one. The conductor and other players cannot read your reasoning — only your \`cue\` and \`report\` tool calls cross the channel boundary. If you reach a decision, ruling, or status update, fire the appropriate tool before moving on. If you find yourself thinking "I already answered that," verify the tool was actually invoked.` +
    (isConductor
      ? `\n\nOperational rules:\n` +
        `- Before assigning parallel work on different branches, provision git worktrees via the \`worktree\` tool so each player has an isolated checkout.\n` +
        `- No player should switch branches without your approval — if a player needs a different branch, provision a worktree for them.\n` +
        `- Before shipping, verify the branch diff scope matches the assigned task (no unrelated changes).`
      : `\n\nPlayer rules:\n` +
        `- Do not switch git branches without the conductor's approval. If no conductor exists, broadcast your intent to the ensemble first. Prefer using the \`worktree\` tool for branch isolation.\n` +
        `- Silent conductor = HOLD indefinitely. Never default to act on an unanswered cue. The conductor may be coordinating other streams, making a different decision than you expected, recovering from comms issues, or awaiting human input. Idle has zero cost. Acting on assumed approval compounds cost across the ensemble. If a conductor decision genuinely blocks you and time matters, send a follow-up \`cue\` reiterating the question — silence is never greenlight.\n` +
        `- When CI surfaces a blocker on a PR you opened (or any task you're driving), escalate to the conductor with diagnosis and proposed routing. Wait for the conductor's dispatch decision. Never \`cue\` other players directly to fix issues — bypassing the conductor invites collisions on shared branches and breaks player-load tracking.`);
}
