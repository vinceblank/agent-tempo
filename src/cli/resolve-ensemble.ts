import { ENV } from '../config';

/**
 * Resolve the target ensemble with the precedence every CLI command uses (#685):
 *
 *   `--ensemble` flag  >  positional arg  >  `AGENT_TEMPO_ENSEMBLE` env  >  `'default'`
 *
 * `up` previously passed a bare positional-derived value and IGNORED the
 * `--ensemble` flag (so `agent-tempo up --ensemble pitest` silently launched in
 * `default`). Centralizing the rule here makes it a single, unit-testable source
 * of truth so it can't drift per-command again.
 *
 * Pure: `env` is injectable (defaults to the live `AGENT_TEMPO_ENSEMBLE`) so the
 * precedence is testable without mutating `process.env`.
 */
export function resolveEnsemble(
  args: { ensemble?: string; positional: string[] },
  env: string | undefined = process.env[ENV.ENSEMBLE],
): string {
  return args.ensemble || args.positional[1] || env || 'default';
}
