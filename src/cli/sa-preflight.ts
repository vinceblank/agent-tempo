/**
 * Search-attribute preflight (PR-3 of the v1.0 rebrand).
 *
 * After the wire-level rename from `ClaudeTempo*` to `AgentTempo*`, every
 * Temporal namespace claude-tempo / agent-tempo touches needs the new
 * search attributes registered before workflows can start. Self-hosted
 * Temporal makes registration a privileged one-shot operator action — the
 * daemon can't do it itself, but it CAN refuse to boot with an actionable
 * error so operators don't see a confusing
 * `INVALID_ARGUMENT: search attribute "AgentTempoEnsemble" is not defined`
 * deep in workflow-start RPC failures hours later.
 *
 * This module is dependency-injected over a `searchAttributesPresent`
 * probe so tests can simulate every namespace-state branch without
 * touching a real Temporal server.
 *
 * Wiring:
 *   - `src/cli/startup.ts` `searchAttrs` step uses the verify-or-instruct
 *     output to surface the actionable error in the TUI bootstrap surface.
 *   - `src/daemon.ts` boot path calls {@link assertSearchAttributesOrExit}
 *     to fail fast on `agent-tempo daemon start` before the worker tries
 *     to register workflows.
 */
import { execFileSync } from 'child_process';

/** Single source of truth — must match `SEARCH_ATTRIBUTES` in `src/cli/startup.ts`. */
export const REQUIRED_SEARCH_ATTRIBUTES: ReadonlyArray<{
  name: string;
  type: 'Keyword' | 'Bool';
}> = Object.freeze([
  { name: 'AgentTempoHostname', type: 'Keyword' },
  { name: 'AgentTempoGitRoot', type: 'Keyword' },
  { name: 'AgentTempoEnsemble', type: 'Keyword' },
  { name: 'AgentTempoPlayerId', type: 'Keyword' },
  { name: 'AgentTempoPlayerType', type: 'Keyword' },
  { name: 'AgentTempoIsConductor', type: 'Bool' },
  { name: 'AgentTempoAttachedHost', type: 'Keyword' },
  { name: 'AgentTempoAttachmentState', type: 'Keyword' },
  { name: 'AgentTempoAttachmentId', type: 'Keyword' },
]);

export interface SearchAttributePreflightOpts {
  temporalAddress: string;
  temporalNamespace: string;
  /**
   * Optional test seam — given a namespace, return the set of search
   * attribute names that ARE currently registered. Defaults to
   * {@link defaultProbeRegisteredAttributes} which shells out to
   * `temporal operator search-attribute list`.
   */
  probe?: (opts: { temporalAddress: string; temporalNamespace: string }) => Promise<Set<string>>;
}

export interface SearchAttributePreflightResult {
  ok: boolean;
  /** Subset of `REQUIRED_SEARCH_ATTRIBUTES` that the probe couldn't find. */
  missing: ReadonlyArray<typeof REQUIRED_SEARCH_ATTRIBUTES[number]>;
  /** Formatted, paste-friendly error message — populated when `ok === false`. */
  message?: string;
  /** Probe error, if the call failed entirely (e.g. `temporal` CLI not on PATH). */
  probeError?: string;
}

/**
 * Default probe — shells out to `temporal operator search-attribute list`.
 * Returns an empty set on any error so callers fall through to the
 * "missing all" branch with an explanatory `probeError` in the result.
 */
export async function defaultProbeRegisteredAttributes(opts: {
  temporalAddress: string;
  temporalNamespace: string;
}): Promise<Set<string>> {
  const args = [
    'operator', 'search-attribute', 'list',
    '--address', opts.temporalAddress,
    '--namespace', opts.temporalNamespace,
  ];
  const raw = execFileSync('temporal', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The CLI prints a human table; we only need the leading column. Each row
  // starts with the attribute name as the first whitespace-delimited token.
  // Header row (and blank lines) are filtered by the AgentTempo prefix /
  // alphanumeric guard below.
  const names = new Set<string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const first = trimmed.split(/\s+/, 1)[0];
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(first)) names.add(first);
  }
  return names;
}

/**
 * Format the missing-SA error message. Paste-friendly: operators copy the
 * `temporal operator search-attribute create` block verbatim.
 */
export function formatPreflightError(
  missing: ReadonlyArray<typeof REQUIRED_SEARCH_ATTRIBUTES[number]>,
  namespace: string,
  probeError?: string,
): string {
  const lines: string[] = [];
  lines.push(`Required search attributes not registered on namespace '${namespace}'.`);
  if (probeError) {
    lines.push(`(Could not probe namespace state: ${probeError})`);
  }
  lines.push('');
  lines.push('Run these commands once per Temporal namespace, then restart the daemon:');
  lines.push('');
  for (const attr of missing) {
    lines.push(
      `  temporal operator search-attribute create ` +
      `--name ${attr.name} --type ${attr.type} --namespace ${namespace}`,
    );
  }
  lines.push('');
  lines.push('(See docs/ops/v1.0-migration.md for the full upgrade walkthrough.)');
  return lines.join('\n');
}

/**
 * Verify all {@link REQUIRED_SEARCH_ATTRIBUTES} are registered on the
 * given namespace. Returns a structured result — callers decide whether
 * to log+continue (boot bootstrap step) or exit non-zero (daemon start).
 */
export async function verifySearchAttributes(
  opts: SearchAttributePreflightOpts,
): Promise<SearchAttributePreflightResult> {
  const probe = opts.probe ?? defaultProbeRegisteredAttributes;
  let registered: Set<string>;
  let probeError: string | undefined;
  try {
    registered = await probe({
      temporalAddress: opts.temporalAddress,
      temporalNamespace: opts.temporalNamespace,
    });
  } catch (err) {
    probeError = err instanceof Error ? err.message : String(err);
    registered = new Set();
  }

  const missing = REQUIRED_SEARCH_ATTRIBUTES.filter((a) => !registered.has(a.name));

  if (missing.length === 0 && !probeError) {
    return { ok: true, missing: [] };
  }

  return {
    ok: false,
    missing,
    probeError,
    message: formatPreflightError(missing, opts.temporalNamespace, probeError),
  };
}

/**
 * Hard variant for the daemon boot path — verify, and if missing, write the
 * actionable error to stderr and exit non-zero. Returns when all attributes
 * are present; never returns in the failure branch.
 *
 * The caller hands in a `processExit` injectable so tests can assert the
 * call without crashing the test runner.
 */
export async function assertSearchAttributesOrExit(
  opts: SearchAttributePreflightOpts & {
    processExit?: (code: number) => never;
    log?: (line: string) => void;
  },
): Promise<void> {
  const result = await verifySearchAttributes(opts);
  if (result.ok) return;
  const log = opts.log ?? ((line: string) => process.stderr.write(line + '\n'));
  log('ERROR: ' + result.message);
  const exit = opts.processExit ?? ((code: number): never => {
    process.exit(code);
    // Unreachable, but satisfies the `never` return.
    throw new Error(`process.exit(${code}) failed`);
  });
  exit(1);
}
