/**
 * parseChatInput — submit-time classifier for the dashboard Composer
 * (#471/#472).
 *
 * Decides what a typed chat row means when the user hits Send:
 *
 *   - `@<player> <text>` → directed cue (route to that player, not the
 *     conductor). The `text` excludes the `@<player> ` prefix.
 *   - `/<command> [args]` → slash command (dispatched locally; never
 *     sent over the wire as a chat message).
 *   - Plain text → conventional cue routed to whatever target the
 *     caller decides (typically the conductor).
 *
 * Edge cases pinned by tests in `tests/parse-chat-input.test.ts`:
 *   - `@<player>` with no text: returns `cue` with empty `text`. The
 *     caller must decide whether to drop, ping, or surface a usage
 *     hint — this parser doesn't impose a policy.
 *   - Leading whitespace before `@` or `/` is tolerated (matches
 *     classifyPaletteInput in src/palette).
 *   - Unknown slash command: still classified as `slash`. The dispatcher
 *     decides whether to delegate to the conductor, surface an inline
 *     status, or no-op.
 *
 * Pure function — no side effects, no React, no imports beyond the
 * shared parseCommand helper.
 */
import { parseCommand } from 'claude-tempo/palette';

export type ParsedChatInput =
  | { kind: 'cue'; target: string; text: string }
  | { kind: 'slash'; name: string; args: string[]; raw: string }
  | { kind: 'plain'; text: string };

/**
 * Match a leading `@<token>` (followed by end-of-string or whitespace +
 * body). The character class MUST stay aligned with `PLAYER_NAME_REGEX`
 * in `src/utils/validation.ts` so dashboard mention parsing and TUI/CLI
 * player-name validation never silently diverge. The Workspace then
 * validates the captured target against the live roster — a mention
 * shaped like a name but unknown to the ensemble surfaces a useful
 * inline error via `<ComposerStatus>`.
 *
 * Pinned by `tests/parse-chat-input.test.ts` (the `@-bad` and
 * `@bob.smith` cases lock in the exact char set). If `PLAYER_NAME_REGEX`
 * changes, those tests break — fix this regex in the same commit.
 */
const MENTION_RE = /^@([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/;

export function parseChatInput(raw: string): ParsedChatInput {
  const trimmed = raw.trim();

  // Slash command takes precedence — `/foo` overrides any `@` interpretation.
  if (trimmed.startsWith('/')) {
    const cmd = parseCommand(trimmed);
    if (cmd) {
      return { kind: 'slash', name: cmd.name, args: cmd.args, raw: cmd.raw };
    }
    // `/` alone or `/   ` falls through to plain — caller decides.
    return { kind: 'plain', text: trimmed };
  }

  // `@<player> ...` directed cue.
  if (trimmed.startsWith('@')) {
    const m = MENTION_RE.exec(trimmed);
    if (m) {
      const target = m[1];
      const text = (m[2] ?? '').trim();
      return { kind: 'cue', target, text };
    }
    // `@` alone or `@<garbage>` falls through to plain — caller can
    // surface an inline error or just send the literal text.
    return { kind: 'plain', text: trimmed };
  }

  return { kind: 'plain', text: trimmed };
}
