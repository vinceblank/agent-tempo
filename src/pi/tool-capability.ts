/**
 * Tool capability classifier (3d / MD-C) — a PURE function mapping a tool name
 * to its risk class. The 3d operator gate and the MD-C headless tool-access
 * posture consume it; this module owns the MECHANISM, tempo-security owns the
 * CONTENT (the name-sets below) and signs off on it.
 *
 *   - `'exec'`       — shell / arbitrary-code execution. HARD-BLOCKED when the
 *                      headless tool-access policy is `restricted` (MD-C). The
 *                      highest-danger class.
 *   - `'high-blast'` — destructive or exfiltration-capable actions (file writes,
 *                      network fetch, ensemble mutation). Allowed unsupervised,
 *                      but routed to the OPERATOR GATE when an operator is armed.
 *   - `'low-risk'`   — read-only / coordination. Always bypasses the gate.
 *
 * UNKNOWN tool names default to {@link UNKNOWN_DEFAULT} — a FAIL-SAFE choice
 * (`'high-blast'`: never silently bypass a tool we don't recognize; gate it when
 * an operator is armed). Whether an unknown tool should instead hard-block
 * (`'exec'`) is a tempo-security posture call — see the cue to security.
 *
 * Matching is CASE-INSENSITIVE on the trimmed tool name. Pi's `tool_call`
 * `toolName` is a bare string (built-ins like `bash`/`read`/`edit`/`write`/`grep`
 * plus the natively-registered agent-tempo MCP tools), so we normalize before
 * lookup.
 *
 * ⚠️ NAME-SET OWNERSHIP: the three Sets are tempo-security's posture content.
 * They are a STARTER set (conductor's examples + Pi built-ins + the agent-tempo
 * coordination/mutation tools) pending security's authoritative sign-off; amend
 * the Set membership without touching the mechanism. The classifier behavior
 * (and its tests) are keyed on representative names that won't move.
 */

/** Risk class for a tool, consumed by the 3d gate + MD-C policy. */
export type ToolCapability = 'exec' | 'high-blast' | 'low-risk';

/** Fail-safe class for an unrecognized tool name (never bypass the unknown). */
export const UNKNOWN_DEFAULT: ToolCapability = 'high-blast';

/**
 * Shell / arbitrary-code execution — hard-blocked at `restricted` (MD-C).
 * CONTENT owned by tempo-security (signed off 2026-06-04).
 *
 * ⚠️ SYNC + GATE-GAP: this is the CANONICAL exec denylist and is a SUPERSET of
 * the current `SHELL_TOOL_NAMES` in `src/pi/extension.ts` — it adds
 * `powershell`/`pwsh`/`cmd`/`run`, which the live restricted-mode gate does NOT
 * yet block. 3d MUST refactor extension.ts to IMPORT `EXEC_TOOLS` from here
 * (single source, dedup) — that closes the gap. Do NOT edit extension.ts now
 * (lead's lane); flagged to lead + security.
 */
export const EXEC_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'shell',
  'exec',
  'sh',
  'powershell',
  'pwsh',
  'cmd',
  'run',
  'process',
  'command',
  'run_command',
]);

/**
 * Destructive / exfiltration-capable — gated when an operator is armed.
 * CONTENT owned by tempo-security (signed off 2026-06-04).
 */
export const HIGH_BLAST_TOOLS: ReadonlySet<string> = new Set([
  // Pi built-in mutating tools.
  'write',
  'edit',
  'multiedit',
  // Network exfiltration surface (arbitrary HTTP incl. POST). NOTE: `websearch`
  // is LOW_RISK (read-only results) — only the fetch/browse family gates.
  'webfetch',
  'web_fetch',
  'fetch',
  'http_request',
  'browser',
  // agent-tempo tools that mutate the ensemble / spawn / tear down / control peers.
  'recruit',
  'destroy',
  'restart',
  'migrate',
  'shutdown',
  'release',       // releases a held player — state change on a peer
  'broadcast',     // fans out to ALL players (amplification)
  'schedule',      // creates a durable autonomous trigger (unschedule is LOW_RISK)
  'pause',
  'play',
  'restore',       // re-spawns a detached player (process spawn)
  // State / artifact destruction (irreversible).
  'save_state',
  'clear_state',
  'coat_check_evict',
  // Lineup spawn (full ensemble from YAML; save_lineup is LOW_RISK).
  'load_lineup',
  // Git state + disk mutation.
  'worktree',
  'stage',
  'cancel_stage',  // discards staged work (irreversible)
  // Quality gates that block/unblock ensemble workflow progress.
  'quality_gate',
  'evaluate_gate',
  // Drive/file mutation.
  'copy_file',
]);

/**
 * Read-only / coordination — always bypasses the gate.
 * CONTENT owned by tempo-security (signed off 2026-06-04).
 */
export const LOW_RISK_TOOLS: ReadonlySet<string> = new Set([
  // Pi built-in read tools.
  'read',
  'grep',
  'glob',
  'ls',
  // Read-only web search (no arbitrary POST — distinct from the web_fetch family).
  'websearch',
  'web_search',
  // agent-tempo read-only / status / messaging coordination tools.
  'cue',
  'report',
  'recall',
  'listen',
  'ensemble',
  'who_am_i',
  'set_name',
  'set_part',
  'set_ensemble_description', // metadata only, no blast radius
  'hosts',
  'attachment_info',
  'agent_types',
  'schedules',
  'stages',
  'gates',
  // Read-only state / coat-check (coat_check_put is bounded 32KB + TTL'd + visible).
  'fetch_state',
  'coat_check_put',
  'coat_check_get',
  'coat_check_list',
  // Removes a future trigger — blast was at schedule-time, not here.
  'unschedule',
  // Writes the coordinator YAML (not arbitrary file write; blast is at load_lineup).
  'save_lineup',
]);

/**
 * Classify a tool name into its risk class. Pure + case-insensitive; unknown
 * names fall through to {@link UNKNOWN_DEFAULT} (fail-safe — never bypass).
 */
export function classify(toolName: string): ToolCapability {
  const name = toolName.trim().toLowerCase();
  if (EXEC_TOOLS.has(name)) return 'exec';
  if (HIGH_BLAST_TOOLS.has(name)) return 'high-blast';
  if (LOW_RISK_TOOLS.has(name)) return 'low-risk';
  return UNKNOWN_DEFAULT;
}
