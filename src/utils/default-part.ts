import path from 'path';

/**
 * Match the common agent-tempo agent-type prefixes so the suffix can be
 * surfaced as a human-readable role:
 *   - `tempo-*`     (shipped types: tempo-conductor, tempo-soloist, …)
 *   - `my-tempo-*`  (per-user overrides under `~/.claude/agents/`)
 *   - `la-tempo-*`  (workspace/project agents under `.claude/agents/`)
 *
 * Anything that doesn't match falls through and the full type name is
 * title-cased instead, so a custom `acme-reviewer` type still reads as
 * `'Acme-reviewer session'` rather than something nonsensical.
 */
const PLAYER_TYPE_PREFIX = /^(my-|la-)?tempo-/i;

/**
 * Roles whose canonical capitalisation is not what naive title-casing
 * produces (e.g. `qa` would become `'Qa'`). Keys are the lowercased
 * suffix after `PLAYER_TYPE_PREFIX` is stripped; values are the
 * display string spliced into `'<value> session'`.
 *
 * Add entries sparingly — most types follow the title-case rule and
 * shouldn't need a special case.
 */
const ROLE_ABBREVIATIONS: Record<string, string> = {
  qa: 'QA',
  po: 'PO',
  devops: 'DevOps',
};

/**
 * Adapter types that are considered "headless" — i.e. they run without
 * an interactive terminal. When a session has no explicit `part` and no
 * player type, a headless adapter gets `'Headless <adapter> session'`
 * instead of the generic `'Session in <basename>'`.
 *
 * Issue #537.
 */
export const HEADLESS_ADAPTERS = new Set([
  'claude-code-headless',
  'copilot',
  'opencode',
  'claude-api',
  'mock',
  'pi',
]);

/**
 * Compute the default `part` text seeded into a fresh session workflow.
 *
 * Issue #450 — replaces the hardcoded `'Conductor session'` literal
 * (which leaked through to non-conductor players via the rev3-cert
 * deferred audit item R3.P2.5) and the role-agnostic
 * `'Session in <basename>'` fallback with a single helper that picks a
 * default reflecting the player's role whenever a player type is
 * resolvable.
 *
 * Resolution order:
 *   1. If `playerType` is set, derive from the suffix after stripping
 *      `tempo-` / `my-tempo-` / `la-tempo-`. Abbreviations live in
 *      `ROLE_ABBREVIATIONS`; everything else is title-cased:
 *        `tempo-conductor`     → `'Conductor session'`
 *        `my-tempo-engineer`   → `'Engineer session'`
 *        `my-tempo-qa`         → `'QA session'`
 *        `my-tempo-devops`     → `'DevOps session'`
 *        `la-tempo-advisor`    → `'Advisor session'`
 *        `acme-reviewer`       → `'Acme-reviewer session'` (no prefix match)
 *   2. Else if `isConductor`, return `'Conductor session'` (the
 *      pre-#450 conductor literal — kept so untyped conductor sessions
 *      still read correctly).
 *   3. Else if the adapter is headless (#537), return
 *      `'Headless <adapterType> session'`.
 *   4. Else fall back to `'Session in <basename(workDir)>'`, or
 *      `'New session'` when no `workDir` is provided.
 */
export function defaultPart(opts: {
  playerType?: string;
  isConductor?: boolean;
  workDir?: string;
  adapterType?: string;
}): string {
  const playerType = opts.playerType?.trim();
  if (playerType) {
    const suffix = playerType.replace(PLAYER_TYPE_PREFIX, '');
    if (suffix) {
      const abbrev = ROLE_ABBREVIATIONS[suffix.toLowerCase()];
      if (abbrev) {
        return `${abbrev} session`;
      }
      const titled = suffix.charAt(0).toUpperCase() + suffix.slice(1);
      return `${titled} session`;
    }
  }
  if (opts.isConductor) {
    return 'Conductor session';
  }
  // Issue #537 — headless adapters get a descriptive default when
  // neither playerType nor isConductor identify the session.
  const adapterType = opts.adapterType?.trim();
  if (adapterType && HEADLESS_ADAPTERS.has(adapterType)) {
    return `Headless ${adapterType} session`;
  }
  if (opts.workDir && opts.workDir.trim()) {
    return `Session in ${path.basename(opts.workDir)}`;
  }
  return 'New session';
}
