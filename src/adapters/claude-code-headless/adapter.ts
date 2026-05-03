/**
 * Headless Claude Code adapter — SDK class.
 *
 * Issue #520. Drives the host's installed `claude` CLI (the official Claude
 * Code binary) as a per-turn `claude -p` subprocess. The whole point: tap
 * subscription extra-usage credits via the host's existing OAuth login —
 * the only ToS-clean way for a third-party tool to reach that pool per
 * Anthropic's authentication policy.
 *
 * Mirrors the claude-api / opencode SDK-class adapters: detached Node
 * subprocess, dual-purpose entry point (`require.main === module`),
 * `claimAttachment` + heartbeat lifecycle inherited from `SdkAttachment`.
 *
 * Class hierarchy: `ClaudeCodeHeadlessAttachment extends SdkAttachment extends BaseAttachment`.
 *
 * **Commit progression for #520**:
 *   - **PR-1 (this commit)**: scaffold — directory layout, descriptor,
 *     class skeleton with stub `invokeSdk` + `run`, recruit pre-flight
 *     (binary + auth probes via `pre-flight.ts`), AgentType extension,
 *     registry registration. No subprocess spawn yet.
 *   - PR-2: lifecycle wiring — `run()` connects Temporal, claims attachment,
 *     spawns `claude -p` per turn, manages session UUID via
 *     `updateMetadataSignal`, env hygiene (strip ANTHROPIC_API_KEY etc).
 *   - PR-3: tool-use loop — stream-json frame parser, --mcp-config inline
 *     JSON synthesis, error-mapper translating subprocess fail modes into
 *     the shared `ApiErrorCategory` classifier (per architect's
 *     ratification of Delta #3 in spike-results comment on #520).
 *   - PR-4: tests + docs + example lineup.
 *
 * Design reference: `docs/design/520-claude-code-headless-adapter.md` —
 * §0 (TL;DR), §2 (adapter precedents), §3 (spawn integration), §5
 * (streaming + state), §6 (wire-protocol), §7 (engineer-facing skeleton).
 */
import * as fs from 'fs';
import type { AdapterDescriptor } from '../../types';
import { SdkAttachment, type SdkDeliverResult } from '../sdk/base';
import { ENV } from '../../config';

/**
 * Descriptor for the claude-code-headless adapter. Colocated with the
 * class so `adapter.ts` has no import dependency on `index.ts` (avoids
 * the circular module-graph cycle QA flagged on copilot's PR-B).
 *
 * Design reference: `docs/design/520-claude-code-headless-adapter.md` §2.
 */
export const claudeCodeHeadlessDescriptor: AdapterDescriptor = {
  adapterId: 'claude-code-headless',
  adapterClass: 'sdk',
  // `claude -p` blocks until the result frame — processingStart/End pairing
  // is mandatory and provided by SdkAttachment.deliver().
  blocksOnLLMTurn: true,
  // SDK class — 30s cadence per design § / lifecycle-rebuild-v2 §4.3.
  // Inherited from BaseAttachment's heartbeat loop via the descriptor.
  heartbeatMs: 30_000,
};

/**
 * Permission mode for `claude -p`. Mirrors the CLI's `--permission-mode`
 * flag; recruit-arg `permissionMode` flows here. Default `'acceptEdits'`
 * per design §4.5 — operator expectation that recruited players can do
 * their job, with `dangerouslySkipPermissions: true` available as the
 * full-bypass opt-in (mutually exclusive).
 */
export type ClaudeCodeHeadlessPermissionMode =
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'
  | 'default'
  | 'dontAsk'
  | 'plan';

/** Construction options for {@link ClaudeCodeHeadlessAttachment}. */
export interface ClaudeCodeHeadlessAdapterOptions {
  /** `--permission-mode` flag value. Default: `'acceptEdits'`. */
  permissionMode?: ClaudeCodeHeadlessPermissionMode;
  /** Pass `--dangerously-skip-permissions` instead of `--permission-mode`. Mutually exclusive with `permissionMode`. */
  dangerouslySkipPermissions?: boolean;
}

/**
 * Unbuffered stderr logger. `fs.writeSync(2, ...)` bypasses Node.js stream
 * buffering so log lines appear immediately even when stderr is redirected
 * to a file. Same pattern claude-api / opencode use.
 */
const log = (...args: unknown[]) => {
  const msg = `[claude-tempo:claude-code-headless] ${args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack ? `${a.message}\n${a.stack}` : a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ')}\n`;
  fs.writeSync(2, msg);
};

/**
 * SDK-class adapter that drives `claude -p` as a per-turn subprocess.
 *
 * **PR-1 status**: scaffold only. `run()` and `invokeSdk()` throw
 * `NotImplementedError` until PR-2 (lifecycle + spawn) and PR-3 (tool-use
 * loop) wire them up. The descriptor + class structure are correct and
 * test-loadable.
 *
 * Concrete adapter overrides (planned):
 *   - PR-2: `run()` — boot Temporal client, claim attachment, hydrate
 *     session UUID from metadata, drive poll loop.
 *   - PR-2: `onSuperseded()` — SIGTERM the in-flight `claude` subprocess
 *     with a 5s grace before SIGKILL.
 *   - PR-3: `invokeSdk(prompt, timeoutMs)` — spawn `claude -p
 *     --output-format stream-json --strict-mcp-config --mcp-config
 *     <synthesized> --session-id <uuid> [--resume <uuid>]
 *     --permission-mode <mode>`, parse streaming frames, return assembled
 *     text + stop_reason + usage on `result` frame.
 *
 * Lifecycle inherited from `SdkAttachment` / `BaseAttachment`: claim,
 * heartbeat, phase watcher, `processingStart`/`End` pairing,
 * `markDelivered`. No reconnect opt-in (matches claude-api / opencode —
 * the daemon's `reconcile-on-boot` recovers from lease loss).
 */
export class ClaudeCodeHeadlessAttachment extends SdkAttachment {
  readonly descriptor: AdapterDescriptor = claudeCodeHeadlessDescriptor;

  /** `--permission-mode` flag value. Resolved at construction; ENV fallback. */
  protected readonly permissionMode: ClaudeCodeHeadlessPermissionMode;
  /** Whether to use `--dangerously-skip-permissions` instead of permissionMode. */
  protected readonly dangerouslySkipPermissions: boolean;
  /** Cached for the per-turn telemetry log (PR-2 populates from env). */
  protected playerName = '';

  constructor(opts: ClaudeCodeHeadlessAdapterOptions = {}) {
    super();
    this.permissionMode = opts.permissionMode
      ?? (process.env[ENV.PERMISSION_MODE] as ClaudeCodeHeadlessPermissionMode | undefined)
      ?? 'acceptEdits';
    this.dangerouslySkipPermissions = opts.dangerouslySkipPermissions === true;
  }

  /**
   * Lease-revocation hook. **PR-2** wires the actual SIGTERM-on-superseded
   * path; this stub satisfies the abstract contract from `SdkAttachment`
   * so the registry can construct the descriptor at module load.
   *
   * Will SIGTERM the in-flight `claude` subprocess with a 5s grace before
   * SIGKILL fallback (design §5.7). Mirrors `opencode/adapter.ts`'s
   * graceful-then-forced pattern.
   */
  protected onSuperseded(): void {
    log('PR-1 scaffold: onSuperseded() not yet implemented (PR-2 wires SIGTERM/SIGKILL on the in-flight claude subprocess).');
  }

  /**
   * Subprocess entry point. **PR-2** — currently a stub that exits with a
   * descriptive error so a misconfigured spawn doesn't silently no-op.
   */
  async run(): Promise<void> {
    log('PR-1 scaffold: claude-code-headless adapter run() not yet implemented (PR-2 lands lifecycle + subprocess spawn).');
    throw new Error('claude-code-headless adapter run() not yet implemented (PR-2 wires lifecycle).');
  }

  /**
   * Per-turn LLM dispatch. **PR-3** — currently a stub.
   *
   * Will spawn `claude -p --output-format stream-json --verbose
   * --strict-mcp-config --mcp-config <inline-json> --session-id <uuid>
   * [--resume <uuid>] --permission-mode <mode>`, parse stream-json frames
   * via `stream-json.ts`, and return the assembled assistant text +
   * stop_reason + usage from the closing `result` frame.
   */
  protected async invokeSdk(_prompt: string, _timeoutMs: number): Promise<SdkDeliverResult> {
    throw new Error('claude-code-headless adapter invokeSdk() not yet implemented (PR-3 wires the tool-use loop).');
  }
}

// Self-exec entry point — same pattern as claude-api / opencode. When this
// file is launched as `node dist/adapters/claude-code-headless/adapter.js`
// (per the PR-2 spawn helper), boot the adapter. When imported by the
// registry during normal MCP-server startup, no-op.
if (require.main === module) {
  const opts: ClaudeCodeHeadlessAdapterOptions = {};
  const pmode = process.env[ENV.PERMISSION_MODE] as ClaudeCodeHeadlessPermissionMode | undefined;
  if (pmode) opts.permissionMode = pmode;
  if (process.env[ENV.DANGEROUSLY_SKIP_PERMISSIONS] === '1') opts.dangerouslySkipPermissions = true;
  new ClaudeCodeHeadlessAttachment(opts).run().catch((err) => {
    log('Fatal error:', err);
    process.exit(1);
  });
}
