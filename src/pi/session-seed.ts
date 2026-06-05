/**
 * Pi session seeding — the SINGLE chokepoint for `appendMessage` on a headless
 * Pi `SessionManager` (H1, epic #645).
 *
 * WHY a chokepoint (load-bearing, PoC-verified against Pi 0.78.0):
 *   Pi's `SessionManager.appendMessage` NEVER validates `content` — every
 *   malformed shape appends "ok". The throw (`"content is not iterable"`) fires
 *   purely at CONSUMPTION: `getLastAssistantText()` /context-build /compaction
 *   scans iterate `message.content` (agent-session.js:2486/2493 in Pi 0.78). So
 *   seed-time sanitization is the ONLY lever agent-tempo controls — a
 *   consumption-site guard would be Pi-internal.
 *
 *   Therefore {@link seedSessionManager} is the one and only place that calls
 *   `appendMessage`, and it runs every entry through {@link sanitizeTranscriptEntry}
 *   first. `headless.ts` MUST NOT call `appendMessage` directly.
 *
 * RESERVED CHOKEPOINT (#645 / H2 OPT-A outcome): no live caller passes a
 * non-empty transcript today — Pi's `loadFromState` resume rides the existing
 * `deliverRestart` → `receiveMessage('self-restart')` → cue-pump path (the
 * restored-state cue lands on the in-memory session; verified by smoke +
 * test/pi-cue-pump-restore.test.ts). `seedSessionManager` is retained as (1) the
 * tested safety chokepoint and (2) the reserved seed gate for the DEFERRED
 * verbatim-transcript epic; the sanitizer is defense-in-depth. NOT dead code.
 *
 * PURE module: no Pi SDK import. Unit-tested with a fake recording
 * `SessionManager` (test/pi-session-seed.test.ts), mirroring
 * `buildPiResourceLoaderOptions`' SDK-free regression test.
 *
 * Determinism boundary: client-side only (no wire/workflow impact).
 */

/**
 * A loose structural view of a Pi transcript entry. Replay data is untrusted
 * (it may be anything that survived durable storage), so the sanitizer accepts
 * `unknown` and narrows.
 */
export interface TranscriptEntry {
  /** Discriminator for the `Message | CustomMessage | BashExecutionMessage` union. */
  role?: unknown;
  /** The crash-bearing field — must be `string | unknown[]` to survive consumption. */
  content?: unknown;
  [key: string]: unknown;
}

/**
 * Minimal structural view of Pi's `SessionManager` — only the method the seed
 * path touches. Real signature: `appendMessage(msg): string` (the entry id); we
 * type the return as `unknown` since the seed path ignores it.
 */
export interface SeedableSessionManager {
  appendMessage(message: TranscriptEntry): unknown;
}

/**
 * Roles `appendMessage` accepts, derived from the installed Pi 0.78 type defs
 * (NOT assumed):
 *   - `@earendil-works/pi-ai` `Message` union → `user` | `assistant` | `toolResult`
 *     (types.d.ts:192/197/211)
 *   - `@earendil-works/pi-coding-agent` extras → `bashExecution` | `custom`
 *     (core/messages.d.ts:16/32)
 * An entry whose `role` is not one of these is not a message Pi can append → DROP.
 */
const ACCEPTED_ROLES: ReadonlySet<string> = new Set([
  'user',
  'assistant',
  'toolResult',
  'bashExecution',
  'custom',
]);

/**
 * The load-bearing predicate (PoC-confirmed against Pi 0.78.0 — no refinement
 * needed). `content` must be a string or an array; anything else (`null`,
 * `undefined`, `{}`, a number) is non-iterable and throws at consumption.
 */
function isWellShapedContent(content: unknown): boolean {
  return typeof content === 'string' || Array.isArray(content);
}

/**
 * Validate a single replay entry. KEEP (return the entry unchanged) iff its
 * `role` is an `appendMessage`-accepted shape AND its `content` is well-shaped
 * (`string | array`); otherwise DROP (return `null`).
 *
 * DROP is the ruled default (architect): a malformed entry has no recoverable
 * content and role-alternation is not a Pi hard-requirement. Coerce-to-`[]` is a
 * documented one-line escape hatch reserved for a turn-pairing sensitivity that
 * has not surfaced — it is intentionally NOT the default.
 *
 * Crash sites this guard protects (Pi 0.78): `agent-session.js:2486` (context
 * build) and `:2493` (`getLastAssistantText` — `for (const c of msg.content)`).
 */
export function sanitizeTranscriptEntry(entry: unknown): TranscriptEntry | null {
  if (entry === null || typeof entry !== 'object') return null;
  const e = entry as TranscriptEntry;
  if (typeof e.role !== 'string' || !ACCEPTED_ROLES.has(e.role)) return null;
  if (!isWellShapedContent(e.content)) return null;
  return e;
}

/**
 * Seed a fresh in-memory `SessionManager` from a durable replay transcript — the
 * ONLY code path that calls `sm.appendMessage`. Each entry is run through
 * {@link sanitizeTranscriptEntry}; survivors are appended in order, malformed
 * entries are dropped. No-op for an empty/undefined transcript (a fresh recruit
 * — the H1 case).
 *
 * @returns the number of entries actually appended (for logging + tests).
 */
export function seedSessionManager(
  sm: SeedableSessionManager,
  transcript: readonly unknown[] | undefined | null,
): number {
  if (!transcript || transcript.length === 0) return 0;
  let appended = 0;
  for (const raw of transcript) {
    const entry = sanitizeTranscriptEntry(raw);
    if (entry === null) continue; // DROP — never reaches the Pi session
    sm.appendMessage(entry);
    appended += 1;
  }
  return appended;
}
