/**
 * Mock adapter — SDK class. Echo + scripted modes (PR-2 of #340-followup).
 *
 * The mock pretends to be a Claude / Copilot session for end-to-end validation
 * harnesses that can't tolerate a real LLM call (no API cost, no rate limits,
 * no human "trust this folder" prompt). Per ADR 0014:
 *
 *   - Extends `SdkAttachment` so phase transitions, processing windows,
 *     heartbeat cadence, and outbox activity look identical to a real SDK
 *     adapter on the dashboard / TUI / CLI surfaces.
 *   - Posts every action through the standard outbox (`submitOutboxUpdate`).
 *     No bespoke wire-protocol surface; nothing in `docs/WIRE-PROTOCOL.md`
 *     changes for PR-2.
 *   - Defense-in-depth gates (build-time exclusion, import-time gate at
 *     `src/adapters/index.ts`, recruit-time rejection at `src/tools/recruit.ts`,
 *     runtime banner from PR-1) keep this file off production paths.
 *
 * Dual-purpose file (matches `src/adapters/copilot/adapter.ts`):
 *
 *   - `import { MockAttachment } from '.../adapter'` → class reference for
 *     the registry. `run()` is NOT invoked.
 *   - `node .../adapter.js` (or `ts-node .../adapter.ts`) → executes `run()`
 *     as the spawned subprocess entry point, gated by `require.main === module`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client, WorkflowHandle } from '@temporalio/client';
import { getConfig, ENV } from '../../config';
import { createTemporalConnection } from '../../connection';
import type { AdapterDescriptor, Message, OutboxEntryInput } from '../../types';
import { SdkAttachment } from '../sdk/base';
import {
  pendingMessagesQuery,
  submitOutboxUpdate,
  updateMetadataSignal,
} from '../../workflows/signals';
import { mockDescriptor } from './descriptor';
import {
  parseScenario,
  matchRule,
  resolveTarget,
  expandTemplate,
  TARGET_CONDUCTOR,
  DEFAULT_DELAY_MS,
  type Scenario,
  type ScenarioAction,
} from './scenario';
import { parsePrefixDirectives } from './prefix';

/** Env vars consumed by the mock adapter. Mirrors `ENV` constants in `src/config.ts`. */
export const MOCK_ENV = {
  MODE: 'CLAUDE_TEMPO_MOCK_MODE',
  SCENARIO: 'CLAUDE_TEMPO_MOCK_SCENARIO',
  // PR-3 reserves CHAOS_SEED / CHAOS_DELAY / CHAOS_THROW; PR-2 ignores them.
} as const;

/** Modes shipped by PR-2. PR-3 adds `silent` + `chaos`. */
export type MockMode = 'echo' | 'scripted';

const POLL_INTERVAL_MS = 2000;
const PER_MESSAGE_TIMEOUT_MS = 60_000;
const WORKFLOW_REGISTER_TIMEOUT_S = 30;

const log = (...args: unknown[]) => {
  // Bypass Node's stream buffering — when stderr is redirected to a file
  // (the daemon log) buffered writes can hide diagnostics during a crash.
  const msg = `[claude-tempo:mock] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}\n`;
  fs.writeSync(2, msg);
};

/** Thrown by `run()` when scenario validation fails — surfaces in daemon log. */
class ScenarioLoadError extends Error {}

/**
 * Read + validate the scenario file referenced by `CLAUDE_TEMPO_MOCK_SCENARIO`.
 * Resolution rules (architect §4.8):
 *
 *   1. Absolute path (starts with `/` or drive letter) — used verbatim.
 *   2. Bare name (no path separators) — resolved against
 *      `<package-root>/scenarios/<name>.yaml` so the conductor can write
 *      `--mockScenario echo-roundtrip` instead of an absolute path.
 *   3. Relative path — resolved against `process.cwd()`.
 *
 * The package root is `path.resolve(__dirname, '..', '..', '..')` from the
 * compiled `dist/adapters/mock/adapter.js` location — same shape Copilot's
 * `resolve(__dirname, '..', '..', '..', 'dist', 'server.js')` uses.
 */
export function resolveScenarioPath(reference: string, packageRoot: string, cwd: string): string {
  if (path.isAbsolute(reference)) return reference;
  if (!reference.includes('/') && !reference.includes(path.sep)) {
    const stem = reference.endsWith('.yaml') ? reference : `${reference}.yaml`;
    return path.join(packageRoot, 'scenarios', stem);
  }
  return path.resolve(cwd, reference);
}

/** Load + parse the scenario referenced by env. Throws `ScenarioLoadError` on failure. */
function loadScenarioFromEnv(): Scenario {
  const ref = process.env[MOCK_ENV.SCENARIO];
  if (!ref) {
    throw new ScenarioLoadError(
      `${MOCK_ENV.SCENARIO} is required when ${MOCK_ENV.MODE}=scripted`,
    );
  }
  // Walk up from compiled location (dist/adapters/mock/adapter.js) → package root.
  const packageRoot = path.resolve(__dirname, '..', '..', '..');
  const absPath = resolveScenarioPath(ref, packageRoot, process.cwd());
  if (!fs.existsSync(absPath)) {
    throw new ScenarioLoadError(`Scenario file not found: ${absPath} (referenced as "${ref}")`);
  }
  const yamlText = fs.readFileSync(absPath, 'utf8');
  try {
    const scenario = parseScenario(yamlText);
    log(`loaded scenario "${scenario.name}" from ${absPath} (${scenario.rules.length} rule(s))`);
    return scenario;
  } catch (err) {
    throw new ScenarioLoadError(
      `Scenario "${ref}" failed to validate: ${(err as Error)?.message ?? err}`,
    );
  }
}

/**
 * Mock adapter. Posts every action through the standard outbox surface,
 * exactly like a real Claude / Copilot session would when its LLM calls a
 * MCP tool. The dispatcher runs scenario actions or `__MOCK__:` directives
 * one at a time, with `defaultDelayMs` between actions so the dashboard sees
 * a realistic processing window.
 */
export class MockAttachment extends SdkAttachment {
  readonly descriptor: AdapterDescriptor = mockDescriptor;

  private readonly mode: MockMode;
  private readonly scenario?: Scenario;
  private polling = false;

  constructor(opts: {
    mode: MockMode;
    scenario?: Scenario;
    client?: Client;
    host?: string;
  }) {
    super({ client: opts.client, host: opts.host });
    this.mode = opts.mode;
    this.scenario = opts.scenario;
  }

  /**
   * Split-brain cancellation hook (`SdkAttachment` §9.3). Mock has no SDK
   * session to disconnect; we just stop polling so the next message doesn't
   * fire `processingStart` against a revoked lease. The base class has
   * already torn down the heartbeat + watcher loops by the time this runs.
   */
  protected onSuperseded(): void {
    log('lease revoked — stopping mock poll loop');
    this.polling = false;
  }

  /**
   * Subprocess entry point. Mirrors `CopilotSdkAttachment.run()` — connect
   * Temporal, wait for the session workflow to register, claim the
   * attachment, then drive a poll loop on `pendingMessages`. Each message
   * runs through `SdkAttachment.deliver()` so the workflow sees the same
   * processingStart/End/markDelivered pairing a real SDK adapter produces.
   */
  async run(): Promise<void> {
    const config = getConfig();
    const playerName = process.env[ENV.PLAYER_NAME] || '';
    const isConductor = process.env[ENV.CONDUCTOR] === 'true';
    const playerId = isConductor
      ? 'conductor'
      : playerName || `mock-${Date.now()}`;
    const expectedWorkflowId = `claude-session-${config.ensemble}-${playerId}`;

    log(`Starting mock adapter (mode=${this.mode}, ensemble=${config.ensemble}, player=${playerId})`);

    const connection = await createTemporalConnection(config);
    const client = new Client({ connection, namespace: config.temporalNamespace });
    this.configureV2(client, os.hostname());

    // Wait for the MCP server's workflow to register — same pattern as
    // Copilot's adapter (poll describe() with a bounded retry budget).
    let pinnedRunId: string | undefined;
    const unpinned = client.workflow.getHandle(expectedWorkflowId);
    for (let attempt = 0; attempt < WORKFLOW_REGISTER_TIMEOUT_S; attempt++) {
      try {
        const desc = await unpinned.describe();
        if (desc.status.name === 'RUNNING') {
          pinnedRunId = desc.runId;
          break;
        }
      } catch {
        // Not yet registered.
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!pinnedRunId) {
      log(`ERROR: workflow ${expectedWorkflowId} did not register within ${WORKFLOW_REGISTER_TIMEOUT_S}s`);
      process.exit(1);
    }
    log(`workflow ready: ${expectedWorkflowId} (runId=${pinnedRunId})`);

    // Wire terminal handler before claim — symmetric with copilot/adapter.ts.
    let shuttingDown = false;
    const cleanup = async (): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      this.polling = false;
      try {
        await this.stopV2Lifecycle('user-stop', /* graceful */ true);
      } catch (err) {
        log('stopV2Lifecycle suppressed:', (err as Error)?.message ?? err);
      }
    };
    this.onTerminal((reason) => {
      log(`V2 terminal (${reason}) — exiting`);
      void cleanup().then(() => process.exit(0));
    });

    let pinned: WorkflowHandle;
    try {
      const expectedAttachmentId = process.env[ENV.ATTACHMENT_ID] || undefined;
      pinned = await this.startV2Lifecycle(expectedWorkflowId, expectedAttachmentId);
      log(`attachment claimed (attachmentId=${this.token?.attachmentId}${expectedAttachmentId ? ', renewed' : ''})`);
    } catch (err) {
      log(`ERROR: claimAttachment failed: ${(err as Error)?.message ?? err}`);
      process.exit(1);
    }

    // Stamp metadata so `recall` / `attachment-info` show the mock player
    // populated like a real session.
    try {
      await pinned.signal(updateMetadataSignal, { sessionId: `mock-${process.pid}` });
    } catch {
      // Workflow may still be initializing; non-fatal.
    }

    process.on('SIGINT', () => { void cleanup().then(() => process.exit(0)); });
    process.on('SIGTERM', () => { void cleanup().then(() => process.exit(0)); });

    // Poll loop — same shape as Copilot's poll, simpler because there's no
    // SDK session to keep alive between iterations.
    this.polling = true;
    log('Mock poll loop started.');
    while (this.polling) {
      try {
        const messages: Message[] = await pinned.query(pendingMessagesQuery);
        for (const msg of messages) {
          if (!this.polling) break;
          await this.processMessage(pinned, msg);
        }
      } catch (err) {
        log('poll error:', (err as Error)?.message ?? err);
      }
      try {
        await this.abortableSleep(POLL_INTERVAL_MS);
      } catch {
        // `abortableSleep` rejects with `aborted:stopped` on terminal/stop —
        // we exit the loop and let cleanup finish.
        break;
      }
    }
    log('Mock poll loop exited.');
  }

  /**
   * Run one inbound message through the SDK delivery wrapper. Inside the
   * wrapped `invokeSdk` callback we choose the action set:
   *
   *   1. `__MOCK__:` prefix → parsed as inline directives (regardless of mode).
   *   2. `mode === 'scripted'` → match against scenario rules.
   *   3. `mode === 'echo'` → reply with `[ECHO] <text>` to the sender.
   *
   * `markDelivered` fires automatically on successful return from `deliver()`,
   * so a `crash` action that throws aborts the ack and the message stays
   * pending — which is what test scenarios that exercise supervisor recovery
   * expect.
   *
   * `protected` rather than `private` so the test subclass in
   * `test/mock-adapter-claim-heartbeat.test.ts` can drive a single message
   * through `deliver()` without spinning the full `run()` poll loop.
   */
  protected async processMessage(pinned: WorkflowHandle, msg: Message): Promise<void> {
    await this.deliver(
      pinned,
      msg,
      msg.text,
      PER_MESSAGE_TIMEOUT_MS,
      async () => {
        const directive = parsePrefixDirectives(msg.text);
        if (directive.matched) {
          for (const err of directive.errors) log(`prefix:`, err);
          await this.dispatchActions(pinned, directive.actions, msg);
          return null;
        }
        if (this.mode === 'scripted') {
          if (!this.scenario) {
            log('scripted mode but no scenario loaded — falling back to no-op');
            return null;
          }
          const rule = matchRule(this.scenario, msg.text);
          if (!rule) {
            log(`no rule matched message from ${msg.from}: "${msg.text.slice(0, 80)}"`);
            return null;
          }
          await this.dispatchActions(pinned, rule.do, msg, this.scenario.defaultDelayMs);
          return null;
        }
        // Echo mode (default).
        await this.submitCue(pinned, msg.from, `[ECHO] ${msg.text}`);
        return null;
      },
      [msg.id],
    );
  }

  /**
   * Run an action sequence. Honors `defaultDelayMs` between actions so the
   * dashboard renders a believable processing window (architect §4.3); the
   * `delayMs` action overrides per-step.
   */
  private async dispatchActions(
    pinned: WorkflowHandle,
    actions: readonly ScenarioAction[],
    inbound: Message,
    defaultDelayMs?: number,
  ): Promise<void> {
    const interStep = defaultDelayMs ?? DEFAULT_DELAY_MS;
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      try {
        if ('cue' in action) {
          const target = resolveTarget(action.cue.to, inbound.from);
          const message = expandTemplate(action.cue.message, inbound.text);
          await this.submitCue(pinned, target, message);
        } else if ('report' in action) {
          await this.submitReport(pinned, action.report.text, action.report.type);
        } else if ('recruit' in action) {
          await this.submitRecruit(
            pinned,
            action.recruit.name,
            action.recruit.workDir,
            action.recruit.agent ?? 'mock',
          );
        } else if ('release' in action) {
          const target = resolveTarget(action.release.target, inbound.from);
          await this.submitRelease(pinned, target);
        } else if ('delayMs' in action) {
          await this.abortableSleep(action.delayMs);
        } else if ('crash' in action) {
          log(`scenario directive: crash "${action.crash.message}"`);
          // process.exit ends the subprocess; supervisor restart is the test
          // surface this exercises.
          process.exit(1);
        }
      } catch (err) {
        log(`action ${i + 1}/${actions.length} failed:`, (err as Error)?.message ?? err);
        // Continue with the rest — partial failure shouldn't abort a whole
        // scenario run unless the failure is process-fatal.
      }
      if (i < actions.length - 1 && interStep > 0) {
        try {
          await this.abortableSleep(interStep);
        } catch {
          break; // stopped mid-run — let cleanup finish.
        }
      }
    }
  }

  // ── Outbox helpers ─────────────────────────────────────────────────────

  private submitCue(pinned: WorkflowHandle, targetPlayerId: string, message: string): Promise<string> {
    const entry: OutboxEntryInput = { type: 'cue', targetPlayerId, message };
    return pinned.executeUpdate(submitOutboxUpdate, { args: [entry] });
  }

  private submitReport(
    pinned: WorkflowHandle,
    text: string,
    reportType: 'result' | 'blocker' | 'question' | 'update',
  ): Promise<string> {
    const entry: OutboxEntryInput = { type: 'report', text, reportType };
    return pinned.executeUpdate(submitOutboxUpdate, { args: [entry] });
  }

  private submitRecruit(
    pinned: WorkflowHandle,
    name: string,
    workDir: string,
    agent: 'claude' | 'copilot' | 'mock',
  ): Promise<string> {
    const entry: OutboxEntryInput = {
      type: 'recruit',
      targetName: name,
      workDir,
      isConductor: false,
      agent,
    };
    return pinned.executeUpdate(submitOutboxUpdate, { args: [entry] });
  }

  private submitRelease(pinned: WorkflowHandle, targetPlayerId: string): Promise<string> {
    // `@conductor` is a sentinel — caller resolves at dispatch time. We pass
    // through whatever target the dispatcher gave us; the outbox-side
    // resolver will reject unknown names.
    if (targetPlayerId === TARGET_CONDUCTOR) targetPlayerId = 'conductor';
    const entry: OutboxEntryInput = { type: 'release', targetPlayerId };
    return pinned.executeUpdate(submitOutboxUpdate, { args: [entry] });
  }
}

// Subprocess entry — only fires when this file is executed directly. Keeps
// the file usable both as an importable class (for the registry) and as a
// spawn target.
if (require.main === module) {
  const modeEnv = (process.env[MOCK_ENV.MODE] ?? 'echo').toLowerCase();
  if (modeEnv !== 'echo' && modeEnv !== 'scripted') {
    log(`ERROR: unsupported ${MOCK_ENV.MODE}="${modeEnv}". PR-2 supports: echo, scripted.`);
    process.exit(1);
  }
  const mode = modeEnv as MockMode;

  let scenario: Scenario | undefined;
  if (mode === 'scripted') {
    try {
      scenario = loadScenarioFromEnv();
    } catch (err) {
      log(`ERROR: ${(err as Error)?.message ?? err}`);
      process.exit(1);
    }
  }

  new MockAttachment({ mode, scenario }).run().catch((err) => {
    log('Fatal:', err);
    process.exit(1);
  });
}
