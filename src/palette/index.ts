/**
 * Pure palette-input classification + filtering helpers.
 *
 * Shared between the TUI (`src/tui/commands.ts`) and the dashboard
 * (`dashboard/src/components/chat/`) so the two surfaces' chat-input
 * autocomplete machinery stays in lockstep — same prefix detection,
 * same filtering semantics, same quote-aware tokenizer.
 *
 * Extracted from `src/tui/commands.ts` in #471/#472 (dashboard chat-input
 * TUI parity bundle). The TUI re-exports every symbol from here so existing
 * callers see no behaviour change. The dashboard imports directly from
 * `agent-tempo/palette` (Vite alias `agent-tempo` → `../src`).
 *
 * **No imports allowed.** Keep this module dependency-free so it
 * tree-shakes cleanly into the dashboard bundle and runs unmodified in
 * any JS host (Node, browser, web workers). If you find yourself
 * reaching for Temporal / MCP / Ink / React / DOM types here, the
 * helper belongs somewhere else.
 */

// ── Tokenizer / parser ──

export interface ParsedCommand {
  /** Command name (without the leading slash). */
  name: string;
  /** Positional arguments after the command name. */
  args: string[];
  /** The original raw input string. */
  raw: string;
  /**
   * #109: `true` when tokenization encountered an opening quote that never
   * closed (e.g. user is mid-typing `/x "hello`). Strictly additive — existing
   * handlers that don't inspect this field keep their forgiving-input behavior
   * unchanged. Future strict-mode callers can opt in by checking the flag and
   * surfacing an error sentinel before dispatch. Absent on well-formed input.
   */
  unterminatedQuote?: boolean;
}

/**
 * Quote-aware tokenizer (#109). Splits on whitespace EXCEPT within balanced
 * `"…"` or `'…'` runs. Backslash escapes are intentionally NOT supported —
 * the command surface is small and escape handling adds failure modes
 * (Windows paths mis-escaping, for example). Callers that need literal
 * quotes inside an argument can use the other quote kind:
 * `/x "with 'apostrophe'"`.
 *
 * Returns `{ tokens, unterminatedQuote }`:
 *  - Well-formed input:  `unterminatedQuote === false`, all tokens split.
 *  - Mid-typed input with an open quote (e.g. `/x "hello`): everything still
 *    flushes as the final token and `unterminatedQuote === true` so downstream
 *    strict callers can distinguish. The TUI's on-every-keystroke consumer
 *    ignores the flag — forgiving input by design.
 *
 * Exported for unit tests; callers outside this module should use
 * {@link parseCommand} which wraps this with slash-prefix validation and
 * command-name lowercasing.
 */
export function tokenize(input: string): { tokens: string[]; unterminatedQuote: boolean } {
  const tokens: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  // Tracks whether any char has been emitted into `cur` during the current
  // token — needed so that an explicit empty string (`""`) becomes a real
  // zero-length token rather than being collapsed with the surrounding
  // whitespace boundary.
  let hasContent = false;

  const flush = () => {
    if (cur.length > 0 || hasContent) {
      tokens.push(cur);
      cur = '';
      hasContent = false;
    }
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      hasContent = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      hasContent = true;
      continue;
    }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      flush();
      continue;
    }
    cur += ch;
    hasContent = true;
  }
  flush();
  return { tokens, unterminatedQuote: inSingle || inDouble };
}

/**
 * Parse raw input into a structured command.
 * Returns null if input is not a slash command (doesn't start with "/").
 *
 * Uses the quote-aware {@link tokenize} helper so
 * `/schedule create foo cron "0 * * * *"` correctly binds the cron
 * expression as a single argument (#109). When the input has an
 * unterminated quote (user mid-typing), the `unterminatedQuote` flag is
 * surfaced on the returned ParsedCommand — existing callers that ignore
 * it keep their pre-#109 forgiving behavior.
 */
export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const { tokens, unterminatedQuote } = tokenize(trimmed.slice(1));
  if (tokens.length === 0) return null;

  const name = tokens[0].toLowerCase();
  const args = tokens.slice(1);

  return unterminatedQuote
    ? { name, args, raw: trimmed, unterminatedQuote: true }
    : { name, args, raw: trimmed };
}

// ── Palette classifier + filter helpers ──

/** Commands that take a player name as their first parameter. */
export const PLAYER_PARAM_COMMANDS: ReadonlySet<string> = new Set([
  'worktree',
  'restart',
  'destroy',
  'attachment-info',
]);

/**
 * Commands with hardcoded subcommands (shown in autocomplete). Keys are
 * command names without the leading slash; values are subcommand tokens
 * the palette shows as completions for the first positional argument.
 */
export const SUBCOMMAND_MAP: Readonly<Record<string, readonly string[]>> = {
  worktree: ['create', 'remove', 'list'],
  stage: ['create', 'list', 'cancel'],
  schedule: ['create', 'delete'],
  lineup: ['load', 'save'],
  ensemble: ['save', 'list', 'show'],
};

/** What the chat input is currently completing, if anything. */
export type PaletteMode = 'command' | 'player' | 'player-arg';

export interface PaletteContext {
  mode: PaletteMode;
  /** Lowercased partial token being completed (may be empty). */
  partial: string;
  /**
   * Prefix of the current input that should be preserved when the user
   * selects a palette item. The selected name is appended to this prefix.
   * For `command`/`player` modes this is always `'/'` or `'@'`. For
   * `player-arg` mode this is `/<cmd> ` (note trailing space).
   */
  replacePrefix: string;
}

/**
 * Classify the current input for palette-autocomplete purposes.
 *
 * The palette is visible in three modes:
 *   - `command`: user is typing `/` + partial command name (no space yet)
 *   - `player` : user is typing `@` + partial player name (no space yet)
 *   - `player-arg`: user typed a {@link PLAYER_PARAM_COMMANDS} command
 *     followed by a space, and is now typing the first positional
 *     argument (a player name)
 *
 * Returns `null` when the input does not match any palette-eligible shape
 * (e.g. plain chat, or a second positional arg).
 *
 * Pure function — safe to call from React render and unit tests.
 */
export function classifyPaletteInput(raw: string): PaletteContext | null {
  const trimmed = raw.trimStart();
  if (!trimmed) return null;

  // Command-name completion: "/rec"
  if (trimmed.startsWith('/') && !trimmed.includes(' ')) {
    return { mode: 'command', partial: trimmed.slice(1).toLowerCase(), replacePrefix: '/' };
  }

  // @-player completion: "@al"
  if (trimmed.startsWith('@') && !trimmed.includes(' ')) {
    return { mode: 'player', partial: trimmed.slice(1).toLowerCase(), replacePrefix: '@' };
  }

  // Player-arg completion: "/restart co"
  if (trimmed.startsWith('/') && trimmed.includes(' ')) {
    const spaceIdx = trimmed.indexOf(' ');
    const cmd = trimmed.slice(1, spaceIdx).toLowerCase();
    const afterCmd = trimmed.slice(spaceIdx + 1);
    // Only surface palette for the FIRST positional arg (no further space yet).
    if (afterCmd.includes(' ')) return null;
    if (PLAYER_PARAM_COMMANDS.has(cmd)) {
      return {
        mode: 'player-arg',
        partial: afterCmd.toLowerCase(),
        replacePrefix: `/${cmd} `,
      };
    }
  }

  return null;
}

/**
 * Map a palette mode to the glyph prefix used when displaying or
 * inserting an autofill selection.
 *
 *   `command` / `player-arg`  → `/`
 *   `player`                  → `@`
 *
 * Centralising the mapping here means renderers (TUI's CommandPalette,
 * dashboard's AutofillPopup) can't drift from the classifier. If a new
 * mode lands, the compiler flags every consumer at once.
 */
export function modeToPrefix(mode: PaletteMode): '/' | '@' {
  return mode === 'player' ? '@' : '/';
}

/**
 * Filter palette command entries by a typed prefix.
 * Prefix may optionally include a leading '/' — it's stripped before matching.
 * An empty prefix returns all commands in order.
 *
 * Pure function — safe to call from React render paths and unit tests.
 */
export function filterPaletteCommands<T extends { name: string }>(
  commands: readonly T[],
  filter: string,
): T[] {
  const prefix = filter.startsWith('/') ? filter.slice(1) : filter;
  if (!prefix) return [...commands];
  const lower = prefix.toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().startsWith(lower));
}

/**
 * Filter a list of player names by a partial, using prefix + segment match
 * (e.g. partial `co` matches `conductor` and `tempo-composer`). Exact
 * matches are excluded (nothing left to complete).
 *
 * Pure function — safe to call from React render and unit tests.
 */
export function filterPlayerNames(names: readonly string[], partial: string): string[] {
  const lower = partial.toLowerCase();
  if (!lower) return [...names];
  return names.filter((n) => {
    const l = n.toLowerCase();
    if (l === lower) return false;
    return l.startsWith(lower) || l.split('-').some((seg) => seg.startsWith(lower));
  });
}
