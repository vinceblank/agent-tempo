/**
 * `__MOCK__:` cue-prefix directive parser (ADR 0014 §4.4).
 *
 * Lets the conductor (or any player) drive a mock adapter live without writing
 * a YAML scenario. A cue body whose first line begins with `__MOCK__:` is
 * interpreted by the mock adapter as one or more inline directives, regardless
 * of the configured mode.
 *
 * Production safety: real adapters (claude-code, copilot, claude-api) NEVER
 * inspect message bodies for this prefix — they pass message content through
 * to their respective LLM as-is. So a `__MOCK__:` directive accidentally
 * cross-pollinated into a production chat is inert. Combined with §7's
 * defense-in-depth gates (mock can't exist in prod), this is safe by default.
 *
 * Grammar (one directive per line; multiple lines OK):
 *
 *     __MOCK__: cue <playerId|@sender|@conductor> <message…>
 *     __MOCK__: report <result|blocker|question|update> <text…>
 *     __MOCK__: delay <milliseconds>
 *     __MOCK__: crash <message…>
 *     __MOCK__: release <playerId|@sender>
 *
 * Anything that doesn't parse is logged and skipped — the mock never
 * silently swallows broken directives, but it never crashes the whole run
 * over a typo either.
 */
import type { ScenarioAction } from './scenario';
import {
  MAX_DELAY_MS,
  TARGET_SENDER,
  TARGET_CONDUCTOR,
} from './scenario';
import { PLAYER_NAME_REGEX } from '../../utils/validation';

export const PREFIX = '__MOCK__:';

/** Result of attempting to parse a body for `__MOCK__:` directives. */
export interface PrefixParseResult {
  /** True iff the body started with the prefix. */
  matched: boolean;
  /** Successfully-parsed directives, in body order. */
  actions: ScenarioAction[];
  /** Per-line errors for unrecognized / malformed directives — caller should log. */
  errors: string[];
}

/**
 * Detect + parse `__MOCK__:` directives in an inbound message body. Returns
 * `matched: false` when the body doesn't start with the prefix (caller falls
 * through to mode-specific handling). When `matched: true`, returns the
 * action sequence the dispatcher should run; `errors` carries per-line
 * complaints so the adapter can log them without abandoning the whole batch.
 */
export function parsePrefixDirectives(body: string): PrefixParseResult {
  if (!body.startsWith(PREFIX)) {
    return { matched: false, actions: [], errors: [] };
  }

  // The prefix line itself counts as a directive — strip the leader.
  // Subsequent lines may carry additional directives; each gets the same
  // treatment regardless of leading whitespace (operators paste from a chat
  // window where indentation is unpredictable).
  const lines = body.split(/\r?\n/);
  const actions: ScenarioAction[] = [];
  const errors: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const stripped = line.startsWith(PREFIX) ? line.slice(PREFIX.length).trim() : line;
    if (stripped.length === 0) continue;

    const action = parseDirective(stripped);
    if (action.ok) {
      actions.push(action.action);
    } else {
      errors.push(`unrecognized directive (${action.reason}): "${rawLine}"`);
    }
  }

  return { matched: true, actions, errors };
}

interface ParseOk { ok: true; action: ScenarioAction; }
interface ParseErr { ok: false; reason: string; }

function parseDirective(text: string): ParseOk | ParseErr {
  // Verb is the first whitespace-delimited token; the rest is the args blob.
  const space = text.search(/\s/);
  const verb = (space === -1 ? text : text.slice(0, space)).toLowerCase();
  const rest = space === -1 ? '' : text.slice(space + 1).trim();

  switch (verb) {
    case 'cue': {
      const m = rest.match(/^(\S+)\s+([\s\S]+)$/);
      if (!m) return { ok: false, reason: 'cue requires <target> <message>' };
      const [, target, message] = m;
      if (!isValidTarget(target)) return { ok: false, reason: `invalid target "${target}"` };
      return { ok: true, action: { cue: { to: target, message } } };
    }
    case 'report': {
      const m = rest.match(/^(\S+)\s+([\s\S]+)$/);
      if (!m) return { ok: false, reason: 'report requires <type> <text>' };
      const [, rawType, body] = m;
      if (!['result', 'blocker', 'question', 'update'].includes(rawType)) {
        return { ok: false, reason: `invalid report type "${rawType}"` };
      }
      return {
        ok: true,
        action: { report: { type: rawType as 'result' | 'blocker' | 'question' | 'update', text: body } },
      };
    }
    case 'delay': {
      const ms = Number.parseInt(rest, 10);
      if (!Number.isFinite(ms) || ms <= 0) return { ok: false, reason: `delay requires positive integer ms` };
      if (ms > MAX_DELAY_MS) return { ok: false, reason: `delay ${ms}ms exceeds cap ${MAX_DELAY_MS}ms` };
      return { ok: true, action: { delayMs: ms } };
    }
    case 'crash': {
      if (rest.length === 0) return { ok: false, reason: 'crash requires <message>' };
      return { ok: true, action: { crash: { message: rest } } };
    }
    case 'release': {
      if (!isValidTarget(rest)) return { ok: false, reason: `invalid target "${rest}"` };
      return { ok: true, action: { release: { target: rest } } };
    }
    default:
      return { ok: false, reason: `unknown verb "${verb}"` };
  }
}

function isValidTarget(t: string): boolean {
  return t === TARGET_SENDER || t === TARGET_CONDUCTOR || PLAYER_NAME_REGEX.test(t);
}
