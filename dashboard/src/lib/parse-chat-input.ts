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
 *     toast — this parser doesn't impose a policy.
 *   - Leading whitespace before `@` or `/` is tolerated (matches
 *     classifyPaletteInput in src/palette).
 *   - Unknown slash command: still classified as `slash`. The dispatcher
 *     decides whether to delegate to the conductor, toast, or no-op.
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
 * Match a leading `@<token>` followed by either end-of-string or a
 * single space. The token uses the same character set as
 * `PLAYER_NAME_REGEX` (src/utils/validation.ts) — letters, digits,
 * dash, underscore. Hyphens may appear inside the name but not as the
 * first or last character (matches existing player-name validation).
 */
const MENTION_RE = /^@([A-Za-z0-9_][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/;

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
    // `@` alone or `@<garbage>` falls through to plain — caller can show
    // a toast like "Invalid mention: …" or just send the literal text.
    return { kind: 'plain', text: trimmed };
  }

  return { kind: 'plain', text: trimmed };
}
