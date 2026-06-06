/**
 * Shared secret-classification — the single source of truth for "does this config
 * key / env-var name hold a credential?" Used by:
 *   - `cli/config-command.ts` — masks secret VALUES in the config display (#684).
 *   - `spawn.ts` — partitions terminal-launch env so secret VALUES go to a 0600
 *     file instead of being inlined into the echoed command (#689).
 *
 * Lives in `utils/` (not `cli/`) so `spawn.ts` can import it without a layering
 * violation (spawn must not depend on the CLI surface). Extracted from
 * config-command.ts in #689 so the two consumers share ONE classifier and can't
 * drift — a secret added to the pattern is masked AND kept off the command line
 * everywhere at once.
 */

/**
 * Config/env keys that hold a credential value and must never be displayed raw or
 * inlined into a command. Extend this (or {@link SECRET_KEY_PATTERN}) when a new
 * secret config field / env var is introduced — both consumers pick it up.
 */
export const SECRET_KEYS = new Set([
  'temporalApiKey',
  'httpToken',
  'readToken',
  'adminToken',
]);

/**
 * Matches credential-bearing key/env names: `*_API_KEY` / `*ApiKey` / `*Token` /
 * `*Secret` / `*Password`. NOT `*Path` fields (those are file LOCATIONS, not the
 * secret material — e.g. `temporalTlsKeyPath` must stay visible); the `path$`
 * guard in {@link isSecretKey} excludes them.
 */
export const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password)/i;

/**
 * True when a config key or environment-variable name holds a credential value
 * that must be masked on display and kept out of an echoed command line.
 *
 * Keys on the NAME, not the value. `*Path` fields are file locations (not secret
 * material) and are explicitly excluded so they stay visible/inline.
 */
export function isSecretKey(key: string): boolean {
  if (/path$/i.test(key)) return false;
  return SECRET_KEYS.has(key) || SECRET_KEY_PATTERN.test(key);
}
