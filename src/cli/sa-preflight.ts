/**
 * Search-attribute preflight (PR-3 of the v1.0 rebrand).
 *
 * After the wire-level rename from `ClaudeTempo*` to `AgentTempo*`, every
 * Temporal namespace agent-tempo / agent-tempo touches needs the new
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
 *   - `src/daemon.ts` boot path calls {@link verifySearchAttributes}
 *     directly to fail fast on `agent-tempo daemon start` before the worker
 *     tries to register workflows.
 *
 * Cloud support:
 *   Temporal Cloud's operator gRPC service is not accessible with namespace
 *   API keys, causing `temporal operator search-attribute list/create` to
 *   fail with "Request unauthorized". When a Cloud namespace is detected
 *   (address contains `.tmprl.cloud` or an API key is configured), the
 *   preflight uses an SDK-based probe: issue a visibility query referencing
 *   each required attribute — a registered attribute returns an empty result
 *   set; an unregistered one throws INVALID_ARGUMENT. Registration
 *   instructions surface `tcld` commands instead of `temporal operator`.
 */
import { execFileSync, spawnSync } from 'child_process';

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
  /** API key for Temporal Cloud — triggers SDK-based probe when set. */
  temporalApiKey?: string;
  /**
   * Optional test seam — given a namespace, return the set of search
   * attribute names that ARE currently registered. Defaults to
   * {@link sdkProbeRegisteredAttributes} when `temporalApiKey` is set,
   * otherwise {@link defaultProbeRegisteredAttributes} which shells out to
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

/** Returns true if the address looks like a Temporal Cloud endpoint. */
export function isTemporalCloud(address: string): boolean {
  return address.includes('.tmprl.cloud');
}

/**
 * Substrings Temporal servers use to signal "this search attribute is not
 * registered". The exact wording varies across server versions and storage
 * backends (e.g. 'is not a valid search attribute', 'is not defined',
 * 'no mapping defined for the field'), so we match a set rather than a
 * single phrase — a wording change must not cause the probe to misclassify
 * an unregistered SA as an unexpected error and re-throw.
 */
const UNREGISTERED_SA_MARKERS = [
  'is not a valid search attribute',
  'is not defined',
  'no mapping defined for the field',
  'unknown or unindexed search attribute',
];

/** gRPC status code for INVALID_ARGUMENT. */
const GRPC_INVALID_ARGUMENT = 3;

/**
 * Classify a visibility-query error as "search attribute not registered".
 *
 * A registered-but-empty attribute returns results; an unregistered one
 * fails. Temporal reports the failure as gRPC INVALID_ARGUMENT — we key on
 * that status code first (wording-independent) and fall back to known
 * message substrings for transports/versions that don't surface a code.
 */
function isUnregisteredAttributeError(err: any): boolean {
  const msg = (err?.message || '').toLowerCase();
  if (UNREGISTERED_SA_MARKERS.some((m) => msg.includes(m))) return true;
  // gRPC ServiceError exposes a numeric `code`; INVALID_ARGUMENT means the
  // query referenced an attribute the namespace doesn't know about.
  if (err?.code === GRPC_INVALID_ARGUMENT) return true;
  return false;
}

/**
 * SDK-based probe — uses the Temporal Client SDK to verify search attribute
 * existence by issuing a visibility query. Works with Temporal Cloud API keys
 * where the `temporal operator` CLI commands are unauthorized.
 *
 * Strategy: for each required attribute, issue `listWorkflowExecutions` with
 * a query referencing that attribute. If the attribute is registered the query
 * returns (possibly empty) results. If not registered, Temporal responds with
 * INVALID_ARGUMENT containing "is not a valid search attribute".
 */
export async function sdkProbeRegisteredAttributes(opts: {
  temporalAddress: string;
  temporalNamespace: string;
  temporalApiKey?: string;
}): Promise<Set<string>> {
  const { Connection } = await import('@temporalio/client');
  const tls = opts.temporalApiKey ? true : undefined;
  const conn = await Connection.connect({
    address: opts.temporalAddress,
    tls: tls as any,
    apiKey: opts.temporalApiKey,
  });

  const registered = new Set<string>();
  try {
    for (const attr of REQUIRED_SEARCH_ATTRIBUTES) {
      // The probe value only has to be syntactically valid for the
      // attribute's type so the visibility query parses. We support
      // Keyword (quoted string literal) and Bool (`true`) here — the only
      // two types in REQUIRED_SEARCH_ATTRIBUTES. A new SA type would need
      // its own literal form added below.
      const testValue = attr.type === 'Bool' ? 'true' : '"__probe__"';
      try {
        await conn.workflowService.listWorkflowExecutions({
          namespace: opts.temporalNamespace,
          query: `${attr.name} = ${testValue}`,
          pageSize: 1,
        });
        registered.add(attr.name);
      } catch (err: any) {
        if (isUnregisteredAttributeError(err)) {
          // Attribute not registered — don't add to set
        } else {
          // Unexpected error — re-throw
          throw err;
        }
      }
    }
  } finally {
    await conn.close();
  }

  return registered;
}

/**
 * Format the missing-SA error message. Paste-friendly: operators copy the
 * registration commands verbatim. Cloud-aware: shows `tcld` commands for
 * Temporal Cloud namespaces.
 */
export function formatPreflightError(
  missing: ReadonlyArray<typeof REQUIRED_SEARCH_ATTRIBUTES[number]>,
  namespace: string,
  probeError?: string,
  cloud?: boolean,
): string {
  const lines: string[] = [];
  lines.push(`Required search attributes not registered on namespace '${namespace}'.`);
  if (probeError) {
    lines.push(`(Could not probe namespace state: ${probeError})`);
  }
  lines.push('');

  if (cloud) {
    lines.push('Register via tcld (Temporal Cloud CLI) or the Cloud UI, then restart the daemon:');
    lines.push('');
    const saFlags = missing.map((attr) => `--sa "${attr.name}=${attr.type}"`).join(' \\\n    ');
    lines.push(`  tcld namespace search-attributes add --namespace ${namespace} \\\n    ${saFlags}`);
    lines.push('');
    lines.push('Or add them manually in the Temporal Cloud UI:');
    lines.push(`  https://cloud.temporal.io → Namespaces → ${namespace} → Search Attributes`);
  } else {
    lines.push('Run these commands once per Temporal namespace, then restart the daemon:');
    lines.push('');
    for (const attr of missing) {
      lines.push(
        `  temporal operator search-attribute create ` +
        `--name ${attr.name} --type ${attr.type} --namespace ${namespace}`,
      );
    }
  }
  lines.push('');
  lines.push('(See docs/ops/v1.0-migration.md for the full upgrade walkthrough.)');
  return lines.join('\n');
}

/**
 * Verify all {@link REQUIRED_SEARCH_ATTRIBUTES} are registered on the
 * given namespace. Returns a structured result — callers decide whether
 * to log+continue (boot bootstrap step) or exit non-zero (daemon start).
 *
 * When `temporalApiKey` is set (or address is a Cloud endpoint), uses the
 * SDK-based probe instead of shelling out to `temporal operator`.
 */
export async function verifySearchAttributes(
  opts: SearchAttributePreflightOpts,
): Promise<SearchAttributePreflightResult> {
  const cloud = isTemporalCloud(opts.temporalAddress) || !!opts.temporalApiKey;
  const defaultProbe = cloud
    ? () => sdkProbeRegisteredAttributes({
        temporalAddress: opts.temporalAddress,
        temporalNamespace: opts.temporalNamespace,
        temporalApiKey: opts.temporalApiKey,
      })
    : () => defaultProbeRegisteredAttributes({
        temporalAddress: opts.temporalAddress,
        temporalNamespace: opts.temporalNamespace,
      });
  const probe = opts.probe ?? defaultProbe;
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
    message: formatPreflightError(missing, opts.temporalNamespace, probeError, cloud),
  };
}

/**
 * Outcome of a single `temporal operator search-attribute create` invocation.
 *
 * Pre-#605 the two registration call sites (`commands.ts:registerSearchAttributes`
 * and `startup.ts:stepSearchAttrs`) ran the create command with `stdio: 'ignore'`
 * and swallowed every non-zero exit as "already exists". That hid the
 * SQLite dev-server's 10-Keyword-per-namespace cap (and any other genuine
 * failure) until a downstream workflow start crashed with the confusing
 * `INVALID_ARGUMENT: search attribute "..." is not defined` — hours later
 * and miles away from the real cause.
 */
export type RegistrationStatus = 'created' | 'already-exists' | 'failed';

export interface RegistrationResult {
  attr: typeof REQUIRED_SEARCH_ATTRIBUTES[number];
  status: RegistrationStatus;
  /** stderr from the temporal CLI, populated when `status === 'failed'`. */
  detail?: string;
}

/**
 * Pure classifier — turn a temporal CLI exit into a {@link RegistrationStatus}.
 * Extracted from {@link registerSearchAttribute} so the matching rules can
 * be unit-tested without mocking `child_process`.
 *
 * Rules:
 *   - exit code 0                  → `created`
 *   - stderr/stdout matches the    → `already-exists` (idempotent)
 *     standard Temporal markers
 *   - anything else                → `failed` (with detail for the operator)
 */
export function classifyRegistrationOutput(
  exitCode: number | null,
  output: string,
  errorMessage?: string,
): { status: RegistrationStatus; detail?: string } {
  if (exitCode === 0) return { status: 'created' };
  if (/already\s*exists/i.test(output) || /AlreadyExists/.test(output)) {
    return { status: 'already-exists' };
  }
  const detail =
    output.trim() || errorMessage || `temporal CLI exited ${exitCode ?? 'with no status'}`;
  return { status: 'failed', detail };
}

/**
 * Register one search attribute. Captures stderr so callers can
 * distinguish "already-exists" (idempotent expected case) from real
 * failures (CLI missing, server unreachable, namespace cap exceeded, …).
 */
export function registerSearchAttribute(
  attr: typeof REQUIRED_SEARCH_ATTRIBUTES[number],
  temporalAddress: string,
  namespace: string,
): RegistrationResult {
  const result = spawnSync('temporal', [
    'operator', 'search-attribute', 'create',
    '--address', temporalAddress,
    '--namespace', namespace,
    '--name', attr.name,
    '--type', attr.type,
  ], { encoding: 'utf8' });

  const classified = classifyRegistrationOutput(
    result.status,
    (result.stderr || '') + (result.stdout || ''),
    result.error?.message,
  );
  return { attr, ...classified };
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
