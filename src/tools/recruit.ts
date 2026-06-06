import { z } from 'zod';
import { Client, WorkflowHandle } from '@temporalio/client';
import { spawnSync } from 'child_process';
import { Config, ConfigSource, conductorWorkflowId, isDevMode, parsePiProviderModel } from '../config';
import { AGENT_TYPES, AgentType, MOCK_MODES } from '../types';
import { resolveSession } from './resolve';
import { submitOutboxUpdate } from '../workflows/signals';
import type { OutboxEntryInput, HostInfo, MockMode, GuardrailPolicy } from '../types';
import { ok, fail, formatError, type TempoToolDescriptor } from './descriptor';
import { resolveAgentType, listAgentTypes } from '../ensemble/agent-types';
import { PLAYER_NAME_MAX, MESSAGE_MAX, PATH_MAX, validatePlayerName } from '../utils/validation';
import { probeSdkInstall } from '../utils/sdk-probe';
import {
  probeClaudeBinary,
  probeClaudeAuth,
} from '../adapters/claude-code-headless/pre-flight';
import { CLAUDE_CODE_PERMISSION_MODES } from '../adapters/claude-code-headless/types';
import { probeCopilotPiPreflight, checkPiNodeFloor, PI_PACKAGE, PI_AI_PACKAGE } from '../pi/probe';

const toolLog = (...args: unknown[]) => console.error('[agent-tempo:recruit]', ...args);

/**
 * True dynamic ESM import (survives tsc's commonjs downlevel) — used to load
 * pi-ai's sessionless `getModel` for the Copilot model-index pre-flight gate.
 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<Record<string, unknown>>;

/**
 * #449 Phase C — check whether the `opencode` binary is on PATH. Used by
 * the recruit pre-flight to fail fast with an actionable error before the
 * adapter spawn activity runs and hits ENOENT mid-flight.
 *
 * Cross-platform: `where` on Windows, `command -v` on POSIX. Both exit 0
 * when found, non-zero otherwise; stdout/stderr captured silently.
 */
function hasOpencodeOnPath(): boolean {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'command';
    const args = process.platform === 'win32' ? ['opencode'] : ['-v', 'opencode'];
    const result = spawnSync(cmd, args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      shell: process.platform !== 'win32',  // POSIX needs the shell built-in
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * #274 M15 — dep-injection surface on the recruit tool registrar.
 *
 * `listHostsFn` lets tests stub host discovery without touching
 * `TestWorkflowEnvironment` internals. Production callers (`src/server.ts`)
 * omit this; the default pulls in `src/utils/hosts.ts` lazily.
 */
export interface RegisterRecruitToolDeps {
  listHostsFn?: (client: Client) => Promise<HostInfo[]>;
}

/**
 * #676 FIX-1 — recruit agent precedence: explicit `argAgent` > operator-SET
 * `configDefault` > `ownAgentType` (this player's mirror-fallback). The
 * `defaultAgentSource` distinguishes an operator-set default (origin
 * flag/env/config/temporal-cli) from the built-in 'claude' default (source
 * 'default') / truly-unset ('none') — only an operator-set default wins over the
 * mirror, so a copilot/pi conductor recruits its own kind by default. Pure +
 * exported for unit testing.
 */
export function resolveRecruitAgent(
  argAgent: AgentType | undefined,
  configDefault: AgentType,
  defaultAgentSource: ConfigSource | undefined,
  ownAgentType: AgentType,
): AgentType {
  if (argAgent) return argAgent;
  const operatorSet = !!defaultAgentSource
    && ['flag', 'env', 'config', 'temporal-cli'].includes(defaultAgentSource);
  return operatorSet ? configDefault : ownAgentType;
}

export function buildRecruitTool(
  client: Client,
  config: Config,
  getPlayerId: () => string,
  handle: WorkflowHandle,
  ownAgentType: AgentType = 'claude',
  /**
   * #676 FIX-1 — the SOURCE of `config.defaultAgent` (from getConfigWithSources),
   * used to distinguish an operator-SET default from the built-in 'claude'
   * default (source 'default'). Undefined → treated as not-operator-set →
   * recruit falls back to `ownAgentType` (preserves the pre-FIX-1 mirror).
   */
  defaultAgentSource?: ConfigSource,
  deps: RegisterRecruitToolDeps = {},
): TempoToolDescriptor {
  // Lazy default — only imports utils/hosts when actually called, so the
  // MCP server's module load graph doesn't drag the whole join layer
  // into every consumer at import time.
  const listHostsFn: NonNullable<RegisterRecruitToolDeps['listHostsFn']> =
    deps.listHostsFn ?? (async (c) => {
      const { listHosts } = await import('../utils/hosts');
      return listHosts(c, {
        force: true, // pre-flight wants "right now" — no cached snapshot
        namespace: config.temporalNamespace,
        taskQueue: config.taskQueue,
      });
    });
  return {
    name: 'recruit',
    description: `Start a new named session in a directory. Rejects if the name is already active. Supports Claude Code or Copilot CLI agents. Defaults to "${ownAgentType}" (same as this session).`,
    params: {
      workDir: z.string().max(PATH_MAX).describe('The working directory for the new session'),
      name: z.string().max(PLAYER_NAME_MAX).describe('Name for the new session'),
      conductor: z.boolean().optional()
        .describe('Whether this session is a conductor (default: false)'),
      initialMessage: z.string().max(MESSAGE_MAX).optional()
        .describe('Optional task or message for the new session (sent after it sets its name)'),
      agent: z.enum(AGENT_TYPES).optional()
        .describe(`Which agent to use (default: "${ownAgentType}", same as this session). "mock" requires dev mode (--dev). "claude-api" runs headless via the Anthropic Messages API — requires ANTHROPIC_API_KEY env var and the @anthropic-ai/sdk optional dependency installed; has access to agent-tempo MCP tools (cue, report, recall, ensemble, …) but NOT file-edit or shell tools (use "claude" for those). "opencode" runs headless via a local opencode serve subprocess; multi-provider (Anthropic, OpenAI, Bedrock, Ollama, …) — requires the @opencode-ai/sdk optional dep and an opencode binary on PATH. opencode players ARE file-op-capable (file edits / shell / web search via OpenCode's built-in tools). "claude-code-headless" runs the official Claude Code CLI as a headless per-turn \`claude -p\` subprocess — requires the \`claude\` binary on PATH AND a logged-in Claude Code session (\`claude auth login\`); turns bill against the host's existing subscription extra-usage credits, NOT a Console API key. claude-code-headless players have full Claude Code tool access (Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch).`),
      model: z.string().regex(/^[a-z0-9][a-z0-9-/.:_]*$/).optional()
        .describe('Model id. For "claude-api": bare Anthropic id (e.g. "claude-opus-4-7"). For "opencode": combined "provider/model" (e.g. "anthropic/claude-opus-4-7", "openai/gpt-4o", "ollama/llama3"). Falls back to AGENT_TEMPO_API_MODEL (claude-api) or AGENT_TEMPO_OPENCODE_MODEL (opencode), then a constants-pinned default. Ignored for claude / copilot / mock adapters.'),
      type: z.string().optional()
        .describe('Agent type name — references a Claude Code agent definition (e.g., "tempo-soloist")'),
      systemPrompt: z.string().optional()
        .describe('Path to a .md file to use as custom agent system prompt (--system-prompt)'),
      host: z.string().optional()
        .describe('Target hostname for cross-machine recruiting. Omit for local spawn.'),
      force: z.boolean().optional()
        .describe('Force-terminate any existing session with this name before recruiting. Use when a previous session is orphaned or stuck.'),
      mockMode: z.enum(MOCK_MODES).optional()
        .describe('Dev-mode only (agent: "mock"). Mock adapter mode. Default: "echo". "silent" never replies (heartbeat-stale validation); "chaos" probabilistic fail/crash injection (env-tuned).'),
      mockScenario: z.string().optional()
        .describe('Dev-mode only (agent: "mock", mockMode: "scripted"). Bare scenario name (resolved against shipped scenarios/) or absolute path to a scenario YAML.'),
      // #520 — claude-code-headless adapter knobs. Both ignored for other adapters.
      permissionMode: z.enum(CLAUDE_CODE_PERMISSION_MODES).optional()
        .describe('claude-code-headless only. Permission mode forwarded to `claude -p --permission-mode`. Default "acceptEdits" auto-approves writes + common fs commands. "bypassPermissions" / "dangerouslySkipPermissions" trades safety for speed in trusted contexts. "plan" plans without executing — not useful for headless players. Mutually exclusive with `dangerouslySkipPermissions`.'),
      dangerouslySkipPermissions: z.boolean().optional()
        .describe('claude-code-headless only. When true, passes `--dangerously-skip-permissions` to `claude -p` instead of `--permission-mode`. Use only in sandboxed/trusted contexts. Mutually exclusive with `permissionMode`.'),
      // Phase 3a / MD-C — headless Pi tool-access policy. Ignored for other agents.
      // NOTE: stays `.optional()` (NOT `.default('restricted')`): this tool's
      // params are rendered to the Pi front-end via renderToPi → the zod→TypeBox
      // converter, which is fail-loud on `.default()` (D1). A schema default would
      // throw at Pi tool registration ("Pi missing tool: recruit"). The concrete
      // 'restricted' default is applied once at the read site below instead.
      toolAccess: z.enum(['restricted', 'standard', 'full']).optional()
        .describe('pi only. Headless Pi tool-class policy. "restricted" (default): agent-tempo tools + Read/Edit/Write; Bash/shell/exec HARD-BLOCKED. "standard": Bash enabled; no tool-level scope restriction (operator/container responsible for scoping). "full": unsandboxed — requires force: true (admin confirmation). Ignored for other agents.'),
      // #700 (P2 / G) — durable guardrail posture. `.optional()` (NOT
      // `.default()`) for the same Pi zod→TypeBox fail-loud reason as toolAccess;
      // absent ⇒ autonomous (the absent-default lives on SessionMetadata).
      guardrailPolicy: z.enum(['autonomous', 'monitored', 'supervised', 'observe-only']).optional()
        .describe('pi only. Durable guardrail posture (#700). "autonomous" (default): no gate, runs free. "monitored": operator-armed observability gate, fail-OPEN (auto-allow on absence). "supervised": fail-CLOSED — dangerous (non-low-risk) ops require human approval, auto-DENY on operator absence. "observe-only": may read/observe/advise but cannot act. P2 is client-cooperative (agent honors its own policy; not tamper-proof — daemon-enforcement is P2.1). Ignored for other agents.'),
    },
    handler: async (args) => {
      const { workDir, name, initialMessage } = args as {
        workDir: string;
        name: string;
        conductor?: boolean;
        initialMessage?: string;
        agent?: AgentType;
        model?: string;
        type?: string;
        systemPrompt?: string;
        host?: string;
        force?: boolean;
        mockMode?: MockMode;
        mockScenario?: string;
        permissionMode?: typeof CLAUDE_CODE_PERMISSION_MODES[number];
        dangerouslySkipPermissions?: boolean;
        toolAccess?: 'restricted' | 'standard' | 'full'; // Zod-defaulted to 'restricted' at parse
        guardrailPolicy?: GuardrailPolicy; // #700 — absent ⇒ autonomous
      };
      const isConductor = (args as any).conductor === true;
      const agent: AgentType = resolveRecruitAgent(
        (args as any).agent, config.defaultAgent, defaultAgentSource, ownAgentType,
      );
      const model = (args as any).model as string | undefined;
      const agentTypeName = (args as any).type as string | undefined;
      const systemPrompt = (args as any).systemPrompt as string | undefined;
      const host = (args as any).host as string | undefined;
      const force = (args as any).force === true;
      const mockMode = (args as any).mockMode as MockMode | undefined;
      const mockScenario = (args as any).mockScenario as string | undefined;
      const permissionMode = (args as any).permissionMode as typeof CLAUDE_CODE_PERMISSION_MODES[number] | undefined;
      const dangerouslySkipPermissions = (args as any).dangerouslySkipPermissions === true;
      // N1 (adapted): normalize to a concrete value ONCE here so the guard below
      // and the outbox entry both see a real value with no scattered `?? 'restricted'`.
      // (A schema `.default()` would be cleaner but the Pi converter rejects it —
      // see the toolAccess param note above.) Omitted → 'restricted'.
      const toolAccess = ((args as any).toolAccess ?? 'restricted') as 'restricted' | 'standard' | 'full';
      // #700 — leave undefined when not supplied (absent ⇒ autonomous on
      // SessionMetadata). Only placed on the entry below when set + agent==='pi'.
      const guardrailPolicy = (args as any).guardrailPolicy as GuardrailPolicy | undefined;

      // ADR 0014 §7 gate 3 — recruit-time rejection of `agent: 'mock'`
      // outside dev mode. Defense-in-depth: even if a hand-edited install
      // had `dist/adapters/mock/` present (gate 1 bypassed) AND somehow
      // got the registry to register the descriptor (gate 2 bypassed),
      // this rejects the request with a clear, actionable error.
      if (agent === 'mock' && !isDevMode()) {
        return fail(
          `agent: "mock" is only available in dev mode. Restart agent-tempo with --dev (or set AGENT_TEMPO_DEV_MODE=1) to enable.`,
        );
      }
      // mockMode / mockScenario are only meaningful with the mock adapter —
      // reject silently-ignored params so users learn the right flag shape.
      if (mockMode != null && agent !== 'mock') {
        return fail(`mockMode is only valid when agent: "mock" (got agent: "${agent}").`);
      }
      if (mockScenario != null && agent !== 'mock') {
        return fail(`mockScenario is only valid when agent: "mock" (got agent: "${agent}").`);
      }
      if (agent === 'mock' && mockMode === 'scripted' && !mockScenario) {
        return fail(`mockMode: "scripted" requires mockScenario (a bare scenario name or path to a YAML file).`);
      }
      // PR-3: silent + chaos modes don't consult the scenario file. Reject
      // explicitly rather than silently ignore so users learn the right
      // shape and don't sit wondering why their scenario wasn't applied.
      if (mockScenario && (mockMode === 'silent' || mockMode === 'chaos')) {
        return fail(
          `mockMode: "${mockMode}" does not use a scenario. Drop mockScenario or switch to mockMode: "scripted".`,
        );
      }
      // #131 / #449 Phase C — model knob is meaningful for claude-api AND
      // opencode (different shapes — bare vs `provider/model` — both flow
      // through the same recruit field). Reject silently-ignored params for
      // the other adapters so users learn the right shape.
      // Local-spawn pre-flight checks (env vars + SDK install + binaries)
      // run only when `host` is unset; cross-host recruits delegate to the
      // target daemon's `availableAgentTypes` advertisement (the existing
      // `checkHostPreflight` path), which already gates on whether the
      // remote daemon resolved the SDK at boot.
      if (model != null && agent !== 'claude-api' && agent !== 'opencode') {
        return fail(`model is only valid when agent: "claude-api" or agent: "opencode" (got agent: "${agent}").`);
      }
      // #520 — claude-code-headless permission knobs are mutually exclusive
      // and only meaningful for that adapter. Reject silently-ignored
      // params so users learn the right shape.
      if (permissionMode != null && agent !== 'claude-code-headless') {
        return fail(`permissionMode is only valid when agent: "claude-code-headless" (got agent: "${agent}").`);
      }
      if (dangerouslySkipPermissions && agent !== 'claude-code-headless') {
        return fail(`dangerouslySkipPermissions is only valid when agent: "claude-code-headless" (got agent: "${agent}").`);
      }
      // Reject an EXPLICIT non-default toolAccess on a non-pi agent. With Zod
      // `.default('restricted')` the omitted case is indistinguishable from an
      // explicit `'restricted'`, so we only flag a non-default value — that is
      // unambiguously a user mistake (toolAccess is ignored for non-pi agents).
      if (toolAccess !== 'restricted' && agent !== 'pi') {
        return fail(`toolAccess is only valid when agent: "pi" (got agent: "${agent}").`);
      }
      if (toolAccess === 'full' && !force) {
        return fail(`toolAccess: "full" (unsandboxed Pi) requires force: true (admin confirmation). "restricted" (default) and "standard" do not.`);
      }
      if (permissionMode != null && dangerouslySkipPermissions) {
        return fail(`permissionMode and dangerouslySkipPermissions are mutually exclusive — pass at most one.`);
      }
      if (agent === 'claude-api' && !host && !force) {
        if (!process.env.ANTHROPIC_API_KEY) {
          return fail(
            `agent: "claude-api" requires the ANTHROPIC_API_KEY environment variable on the spawn host. Set it before recruiting (export ANTHROPIC_API_KEY=sk-...) or use \`force: true\` to bypass this check.`,
          );
        }
        try {
          require.resolve('@anthropic-ai/sdk');
        } catch {
          return fail(
            `agent: "claude-api" requires the @anthropic-ai/sdk optional dependency. Install with \`npm install @anthropic-ai/sdk\` and retry, or use \`force: true\` to bypass this check.`,
          );
        }
      }
      // #449 Phase C — opencode pre-flight. Two checks: the optional SDK
      // (signal that opencode integration is intended on this host) AND
      // the `opencode` binary on PATH (the adapter spawns `opencode serve`
      // as a subprocess). Cross-host recruits skip both — the target
      // daemon's `availableAgentTypes` is the gate there.
      if (agent === 'opencode' && !host && !force) {
        if (!probeSdkInstall('@opencode-ai/sdk')) {
          return fail(
            `agent: "opencode" requires the @opencode-ai/sdk optional dependency. Install with \`npm install @opencode-ai/sdk\` and retry, or use \`force: true\` to bypass this check.`,
          );
        }
        if (!hasOpencodeOnPath()) {
          return fail(
            `agent: "opencode" requires the \`opencode\` binary on PATH. Install with \`npm install -g opencode-ai\` and retry, or use \`force: true\` to bypass this check.`,
          );
        }
      }
      // #520 — claude-code-headless pre-flight. Two checks, both bounded by
      // short timeouts (3s + 5s). The auth probe uses the official `claude
      // auth status` subcommand — no billed API call. Cross-host recruits
      // skip both — the target daemon's `availableAgentTypes` is the gate
      // there (PR-2 wires the daemon-side probe).
      if (agent === 'claude-code-headless' && !host && !force) {
        const claudeBin = config.claudeBin ?? 'claude';
        const binProbe = probeClaudeBinary(claudeBin);
        if (!binProbe.ok) {
          return fail(`agent: "claude-code-headless" pre-flight failed: ${binProbe.error} Use \`force: true\` to bypass.`);
        }
        const authProbe = probeClaudeAuth(claudeBin);
        if (!authProbe.loggedIn) {
          return fail(`agent: "claude-code-headless" pre-flight failed: ${authProbe.error} Use \`force: true\` to bypass.`);
        }
      }
      // #532 — copilot pre-flight. SDK-only probe (mirrors claude-api's
      // pattern; copilot has no subprocess CLI on PATH). The bridge
      // subprocess hard-requires `@github/copilot-sdk` at module load
      // (`src/adapters/copilot/adapter.ts:71`), so without this gate the
      // user only learns of the missing dep AFTER bridge spawn —
      // adapter crashes with `process.exit(1)` and the player sits in
      // `booting` until lease timeout. We use `probeSdkInstall` (FS walk)
      // rather than `require.resolve` because pnpm layouts without a
      // top-level hoisted link otherwise false-negative; see issue #532
      // investigation footnote. GITHUB_TOKEN / Copilot CLI login are
      // intentionally NOT checked: the SDK falls through to the
      // logged-in user (`adapter.ts:31, :263`), so token presence is not
      // a hard requirement. Cross-host recruits skip — the target
      // daemon's `availableAgentTypes` is the gate there.
      if (agent === 'copilot' && !host && !force) {
        if (!probeSdkInstall('@github/copilot-sdk')) {
          return fail(
            `agent: "copilot" requires the @github/copilot-sdk optional dependency. Install with \`npm install @github/copilot-sdk\` and retry, or use \`force: true\` to bypass this check.`,
          );
        }
      }
      // Node-floor (Decision B, #645) — AUTHORITATIVE, NON-BYPASSABLE gate, so it
      // sits ABOVE the `&& !force` block below. Unlike sdk-probe (a filesystem
      // heuristic with possible false-negatives, where `force` stays legitimate),
      // the Node floor has NO false-negative — `process.versions.node` is
      // authoritative and Pi literally cannot import on sub-22.19 — so there is no
      // legitimate override. Checked even under `force: true`, matching the
      // unconditional runHeadlessPi backstop, so recruit fails clean BEFORE spawn
      // in ALL local cases. Local recruit only — cross-host (`host` set) defers to
      // the target daemon's availableAgentTypes. Gates BOTH the Copilot and
      // Anthropic/Pi-default paths below.
      if (agent === 'pi' && !host) {
        const nodeFloor = checkPiNodeFloor();
        if (!nodeFloor.ok) return fail(`agent: "pi" — ${nodeFloor.reason}`);
      }
      // Phase 3a — headless Pi pre-flight. The Pi SDK is an optional Node-22.19+
      // dep required at the headless entry; gate at recruit (cross-host skips —
      // the target daemon's availableAgentTypes is the gate there).
      if (agent === 'pi' && !host && !force) {
        // Validate the model selector format up front (provider/model).
        let parsedModel: { provider: string; model: string } | undefined;
        if (model) {
          const r = parsePiProviderModel(model);
          if ('error' in r) return fail(`agent: "pi" — ${r.error} Or use \`force: true\` to bypass.`);
          parsedModel = r;
        }
        if (parsedModel?.provider === 'github-copilot') {
          // Copilot-via-Pi: full pre-flight (deps + version floor + Copilot auth +
          // model-index Gate 4 via pi-ai's sessionless getModel, injected here).
          let resolveModel: ((p: string, m: string) => unknown) | undefined;
          try {
            const piAi = await esmImport(PI_AI_PACKAGE);
            resolveModel = piAi.getModel as (p: string, m: string) => unknown;
          } catch { /* dep-present gate inside the preflight fails first if pi-ai is unimportable */ }
          const pf = probeCopilotPiPreflight({ requestedModel: parsedModel, resolveModel });
          if (!pf.available) return fail(`agent: "pi" (Copilot) pre-flight failed: ${pf.reason}`);
        } else if (!probeSdkInstall(PI_PACKAGE)) {
          // Anthropic / Pi-default path: just require the Pi SDK installed.
          return fail(
            `agent: "pi" requires the ${PI_PACKAGE} optional dependency (Node >= 22.19). Install with \`npm install -g ${PI_PACKAGE}\` and retry, or use \`force: true\` to bypass.`,
          );
        }
      }

      // Resolve agent type if provided
      let agentDefinition: string | undefined;
      let agentDefinitionPath: string | undefined;
      let agentDefinitionDescription: string | undefined;
      let nativeResolvable: boolean | undefined;
      let allowedTools: string[] | undefined;
      if (agentTypeName) {
        const info = resolveAgentType(agentTypeName);
        if (!info) {
          const available = listAgentTypes().map(t => t.name);
          return fail(`Unknown agent type "${agentTypeName}". Available types: ${available.length ? available.join(', ') : '(none)'}`);
        }
        agentDefinition = info.name;
        agentDefinitionPath = info.path;
        agentDefinitionDescription = info.description;
        nativeResolvable = info.nativeResolvable;
        allowedTools = info.allowedTools;
      }

      // Validate name
      const nameError = validatePlayerName(name);
      if (nameError) {
        return fail(nameError);
      }
      if (name === 'conductor' && !isConductor) {
        return fail(`The name "conductor" is reserved for conductor sessions. Use a different name, or set conductor: true.`);
      }

      // ── #274 AC12 — cross-host recruit pre-flight ──
      //
      // When `host` is specified, verify that the target is live + has
      // the requested agent runtime available BEFORE submitting to the
      // outbox. Otherwise `recruit --host foo` could queue forever on a
      // per-host task queue nobody's listening on (the exact failure
      // mode #274 set out to close).
      //
      // `force: true` bypasses pre-flight entirely (AC12d) — covers the
      // scripted-recruit-on-about-to-boot-daemon case plus any other
      // "I know what I'm doing" override. RPC failure during pre-flight
      // falls through with a warning (AC12e) so today's recruit
      // availability characteristics are preserved.
      if (host && !force) {
        try {
          const hosts = await listHostsFn(client);
          const preflightError = checkHostPreflight(hosts, host, agent);
          if (preflightError) return fail(preflightError);
        } catch (err) {
          toolLog(
            `Host pre-flight RPC failed for "${host}"; proceeding without validation (use --force to silence this warning): ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      try {
        // Check if a conductor already exists when recruiting a conductor
        if (isConductor) {
          try {
            const conductorWfId = conductorWorkflowId(config.ensemble);
            const conductorHandle = client.workflow.getHandle(conductorWfId);
            const desc = await conductorHandle.describe();
            if (desc.status.name === 'RUNNING') {
              if (force) {
                await conductorHandle.terminate(`Force-terminated for re-recruit by ${getPlayerId()}`);
              } else {
                return fail(`A conductor is already running in ensemble "${config.ensemble}". Use \`agent-tempo conduct --replace\` from the CLI to replace it, \`stop\` it first, or use \`force: true\` to replace it.`);
              }
            }
          } catch {
            // No existing conductor — proceed
          }
        }

        // Check if a session with this name is already active
        const existing = await resolveSession(client, config.ensemble, name);
        if (existing) {
          if (force) {
            // Force-terminate the existing session before recruiting
            await existing.terminate(`Force-terminated for re-recruit by ${getPlayerId()}`);
            // Best-effort notify conductor
            try {
              const condId = conductorWorkflowId(config.ensemble);
              const condHandle = client.workflow.getHandle(condId);
              await condHandle.signal('receiveMessage', {
                from: 'system',
                text: `Session "${name}" was force-terminated for re-recruit by ${getPlayerId()}.`,
                responseRequested: false,
              });
            } catch {
              // Conductor may not exist — that's fine
            }
          } else {
            return fail(`Session **${name}** is already active. Use \`cue\` to send it a message, \`stop\` it first, or use \`force: true\` to replace it.`);
          }
        }

        const entry = {
          type: 'recruit',
          targetName: name,
          workDir,
          isConductor,
          initialMessage,
          agent,
          systemPrompt: agentDefinition ? undefined : systemPrompt,
          targetHostname: host,
          agentDefinition,
          agentDefinitionPath,
          agentDefinitionDescription,
          nativeResolvable,
          allowedTools,
          claudeBin: config.claudeBin,
          ...(agent === 'mock' ? { mockMode: mockMode ?? 'echo' } : {}),
          ...(agent === 'mock' && mockScenario ? { mockScenario } : {}),
          ...(agent === 'claude-api' && model ? { model } : {}),
          // #520 — claude-code-headless permission knobs flow through the
          // outbox so PR-2's spawn helper picks them up via env. Fields
          // are only present on the entry when actually set; the
          // OutboxEntryInput shape will gain typed `permissionMode` /
          // `dangerouslySkipPermissions` fields in PR-2.
          ...(agent === 'claude-code-headless' && permissionMode ? { permissionMode } : {}),
          ...(agent === 'claude-code-headless' && dangerouslySkipPermissions ? { dangerouslySkipPermissions: true } : {}),
          // Phase 3a / MD-C — explicit toolAccess on the entry. Normalized at the
          // read site (above) to a concrete value, so the spawned gate + audit
          // always see one without a fallback here.
          ...(agent === 'pi' ? { toolAccess } : {}),
          // #700 (P2 / G) — durable guardrail posture; only when explicitly set
          // (absent ⇒ autonomous default on SessionMetadata).
          ...(agent === 'pi' && guardrailPolicy ? { guardrailPolicy } : {}),
        } as OutboxEntryInput;
        const entryId = await handle.executeUpdate(submitOutboxUpdate, { args: [entry] });

        return ok(`Recruit request submitted for **${name}** in ${workDir}. The session will be spawned shortly. (outbox: ${entryId})`);
      } catch (err) {
        return fail(`Failed to recruit: ${formatError(err)}`);
      }
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// #274 AC12 — host pre-flight validation (exported for unit tests)
// ────────────────────────────────────────────────────────────────────────

/**
 * Given a host liveness+profile snapshot, validate that `targetHost` is
 * (a) known, (b) recruit-ready, and (c) advertises support for
 * `requestedAgent`. Returns a user-facing error string when validation
 * fails, or `null` when all checks pass.
 *
 * Profile-missing is treated as a soft pass (the daemon is alive but
 * didn't signal a profile, e.g. rolling-upgrade scenario or global
 * maestro was unreachable at its boot). We fall through rather than
 * fail — M10 / AC11c says operational UX beats strict enforcement when
 * information is genuinely absent.
 *
 * Exported for unit testing per the M15 dep-injection pattern.
 */
export function checkHostPreflight(
  hosts: HostInfo[],
  targetHost: string,
  requestedAgent: AgentType,
): string | null {
  const match = hosts.find((h) => h.hostname === targetHost);
  if (!match) {
    const knownNames = hosts.map((h) => h.hostname);
    const suggestion = nearestHostname(targetHost, knownNames);
    const available = knownNames.length > 0 ? knownNames.join(', ') : '(none — no daemons currently polling)';
    const hint = suggestion && suggestion !== targetHost ? ` Did you mean "${suggestion}"?` : '';
    return `Unknown host "${targetHost}".${hint} Available: ${available}. Use \`force: true\` to bypass this check.`;
  }
  if (match.freshness !== 'live' || !match.recruitReady) {
    return `Host "${targetHost}" is not recruit-ready right now (freshness=${match.freshness}, recruitReady=${match.recruitReady}). Wait for the daemon to signal again, or use \`force: true\` to bypass.`;
  }
  // Profile-missing → soft pass. Daemon is alive + recruit-ready; we
  // just don't have capability info. Log-level guidance could be added
  // later; for now we accept to avoid false-negative rejection.
  if (match.profile && match.profile.availableAgentTypes) {
    if (!match.profile.availableAgentTypes.includes(requestedAgent)) {
      const supports = match.profile.availableAgentTypes.length > 0
        ? match.profile.availableAgentTypes.join(', ')
        : '(none advertised)';
      return `Host "${targetHost}" cannot run \`${requestedAgent}\` (supports: ${supports}). Use \`force: true\` to bypass this check.`;
    }
  }
  return null;
}

/**
 * Pick the closest hostname to `target` by Levenshtein distance. Returns
 * `null` when `candidates` is empty OR the nearest match is so distant
 * (edit distance ≥ half the longer string's length) that suggesting it
 * would be misleading. Exported for tests.
 */
export function nearestHostname(target: string, candidates: string[]): string | null {
  if (candidates.length === 0) return null;
  let best: { name: string; dist: number } | null = null;
  for (const cand of candidates) {
    const dist = levenshtein(target, cand);
    if (best === null || dist < best.dist) best = { name: cand, dist };
  }
  if (!best) return null;
  const ratioThreshold = Math.max(target.length, best.name.length) / 2;
  return best.dist < ratioThreshold ? best.name : null;
}

/** Iterative O(n·m) Levenshtein distance. 15 lines, no dep. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // previous row of distances
  let prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const curr = new Array<number>(b.length + 1);
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}
