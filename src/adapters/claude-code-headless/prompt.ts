/**
 * Pure prompt-building helpers for the claude-code-headless adapter.
 *
 * Issue #536 root cause: `invokeSdkWithBatch` in `adapter.ts` was
 * inlining both the per-message attribution prompt AND the per-turn
 * argv composition, with no `--append-system-prompt` and no
 * MAESTRO_ACK augmentation. The model received only
 * `[from X]: <text>` framing, no MCP-tool guidance, and replied with
 * stdout prose that the adapter captured but had nowhere to deliver
 * — so cues from the dashboard saw zero cue-back replies.
 *
 * This module factors the two prompt-build steps out of the adapter
 * for two reasons:
 *
 *   1. **Testability.** Both helpers are pure — no Temporal client,
 *      no subprocess, no filesystem. The test in
 *      `tests/adapters/claude-code-headless/prompt.test.ts` exercises
 *      every `--append-system-prompt` invariant + every MAESTRO_ACK
 *      conditional shape directly, instead of having to stub a
 *      whole subprocess + spawn pipeline.
 *
 *   2. **Read-locality.** The `invokeSdkWithBatch` body in
 *      `adapter.ts` was already 80+ lines of mixed concerns
 *      (subprocess spawn, env hygiene, stream-json read loop,
 *      cleanup). Extracting the string composition keeps the per-
 *      turn driver focused on the I/O side.
 */
import type { Message } from '../../types';
import { MAESTRO_ACK, buildSdkSystemPrompt } from '../sdk/system-prompt';
import type { ClaudeCodeHeadlessPermissionMode } from './types';

/**
 * Compose the per-turn prompt text from the workflow's queued
 * messages. Mirrors copilot's poll-loop pattern at
 * `src/adapters/copilot/adapter.ts:639-645` — same conditional
 * MAESTRO_ACK augmentation per `m.isMaestro`, same `\n\n` join.
 *
 * The attribution prefix is `[from X]:` (matches the pre-#536
 * shape in `invokeSdkWithBatch`); copilot's `[Message from X]:` is
 * stylistic drift from a different vintage but is left unchanged
 * here since #536 is scoped to the cue-back framing fix, not a
 * cross-adapter prompt-styling unification.
 *
 * @returns Empty string when `messages` is empty (no `\n\n` floor).
 */
export function buildPromptText(messages: Message[]): string {
  return messages
    .map((m) => {
      const line = `[from ${m.from}]: ${m.text}`;
      return m.isMaestro ? line + MAESTRO_ACK : line;
    })
    .join('\n\n');
}

export interface BuildClaudeArgsOpts {
  /** Deterministic session UUID — pinned via `--session-id` on first
   * turn, found via `--resume` on subsequent turns. */
  sessionId: string;
  /** True when the per-cwd JSONL session file already exists.
   * Toggles `--resume <id>` vs `--session-id <id>` (mutually
   * exclusive in `claude -p` v2.1.126+). */
  isResume: boolean;
  /** Already-stringified inline `--mcp-config` JSON. The adapter
   * computes this from `getConfig()` at call time; the helper just
   * threads the bytes. */
  mcpConfig: string;
  /** Resolved permission mode (default `'acceptEdits'`). Ignored
   * when `dangerouslySkipPermissions` is true — they're mutually
   * exclusive per #520 and rejected at recruit-tool layer. */
  permissionMode: ClaudeCodeHeadlessPermissionMode;
  /** When true, emit `--dangerously-skip-permissions` and skip
   * `--permission-mode`. */
  dangerouslySkipPermissions: boolean;
  /** Per-turn system-prompt content. Pass the result of
   * `buildSdkSystemPrompt({ ensemble })` for the canonical #536
   * framing. */
  systemPrompt: string;
  /** Final positional argument — the prompt text the model receives
   * for this turn. Pass the result of `buildPromptText(messages)`. */
  promptText: string;
}

/**
 * Compose the `claude -p` argv for a single turn. Pure function so
 * tests can pin every flag invariant without mocking `spawn`.
 *
 * #536 change: emits `--append-system-prompt <systemPrompt>` to
 * inject the canonical "use your MCP tools to reply" framing into
 * the model's per-request system prompt. The flag is in the request
 * itself, so it dodges the MCP-startup race the priming-turn pattern
 * would otherwise mitigate (per the issue body's "MCP startup race —
 * secondary" footnote).
 *
 * Invariant ordering (kept stable so transcripts and CI snapshots
 * compare cleanly across releases):
 *   `-p` → `--output-format` → `--verbose` → `--strict-mcp-config`
 *   → `--mcp-config` → `--append-system-prompt`
 *   → (`--resume` | `--session-id`)
 *   → (`--dangerously-skip-permissions` | `--permission-mode`)
 *   → `<promptText>`
 */
export function buildClaudeArgs(opts: BuildClaudeArgsOpts): string[] {
  return [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--strict-mcp-config',
    '--mcp-config', opts.mcpConfig,
    // #536 — per-turn system-prompt injection. Without this, the
    // model received only `[from X]: <text>` framing and had no
    // reason to call the `cue` MCP tool to reply.
    '--append-system-prompt', opts.systemPrompt,
    // Mutually exclusive — `claude -p` v2.1.126 rejects the combo
    // `--session-id X --resume X` with: *"--session-id can only be
    // used with --continue or --resume if --fork-session is also
    // specified."* Spike-confirmed during PR-4 §8.4 manual smoke;
    // see #520 design doc §16.9. First turn uses `--session-id`
    // to PIN the deterministic UUID; subsequent turns use `--resume`
    // alone (the resume target IS the same UUID — the JSONL
    // filename embeds it, so claude finds the right session).
    ...(opts.isResume
      ? ['--resume', opts.sessionId]
      : ['--session-id', opts.sessionId]),
    ...(opts.dangerouslySkipPermissions
      ? ['--dangerously-skip-permissions']
      : ['--permission-mode', opts.permissionMode]),
    // Trailing positional argument — the prompt text. The CLI accepts
    // up to ARG_MAX bytes here (Windows: 32KB). Per #520 §11.5 spike
    // check, typical multi-cue batches stay well under the limit.
    opts.promptText,
  ];
}

// Re-export `buildSdkSystemPrompt` so `adapter.ts` imports it from
// here alongside `buildClaudeArgs` / `buildPromptText` instead of
// reaching across two modules.
export { buildSdkSystemPrompt };
