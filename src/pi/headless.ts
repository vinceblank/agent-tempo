/**
 * Headless Pi runtime (Phase 3a). Spawned by the daemon (spawnPiHeadless →
 * src/adapters/pi/adapter.ts) for a recruited `agent: 'pi'` player. No human, no
 * terminal: it constructs Pi's `createAgentSession` with the agent-tempo
 * extension injected INLINE, and the module-scope extension singleton
 * (createPiExtension, mode='headless') owns claim/heartbeat/tool-registration/
 * cue-pump on `session_start`. Reuses ~everything from Phases 1–2.
 *
 * Lifecycle:
 *   1. probe Pi SDK; resolve the model via pi-ai `getModel` — a bad/unindexed
 *      model fails CLEAN (exit before attach, no orphan — architect's backstop).
 *   2. createAgentSession({ resourceLoader: DefaultResourceLoader({
 *        extensionFactories: [ext] }), model? }).
 *   3. await session.bindExtensions({}) → fires session_start → the singleton
 *      attaches (claim + heartbeat + tools + cue pump). bindExtensions IS the
 *      explicit bootstrap (not "hope session_start fires").
 *   4. stay alive until a shutdown signal (SIGTERM/SIGINT).
 *   5. RELIABLE detach (headless owns the exit): detachAllPiRuntimesForExit()
 *      [await adapterExited] → session.dispose() → process exit.
 *
 * ESM note: the Pi SDK is an ESM-only optional dep; we import it via a
 * `Function`-wrapped dynamic `import()` so tsc (module=commonjs) doesn't
 * downlevel it to `require()` — Node resolves the real ESM module at runtime.
 *
 * Determinism boundary: client-side only.
 */
import { getConfig, sessionWorkflowId, ENV, type Config } from '../config';
import { probeSdkInstall } from '../utils/sdk-probe';
import { createPiExtension, detachAllPiRuntimesForExit, setRuntimeSession, type PiToolAccess } from './extension';
import type { GuardrailPolicy } from '../types';
import { EXEC_TOOLS } from '../security/tool-capability';
import { PI_PACKAGE, PI_AI_PACKAGE, checkPiNodeFloor } from './probe';
import { seedSessionManager, type SeedableSessionManager } from './session-seed';
import type { PiAgentSession } from './pi-types';

const log = (...args: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.error('[agent-tempo:pi-headless]', ...args);
};

/**
 * True dynamic ESM import that survives tsc's commonjs downleveling. `import(x)`
 * with a literal would be rewritten to a `require`-based helper (breaks on an
 * ESM-only package); the `Function` indirection keeps a native `import()` at
 * runtime so Node loads the real ESM module.
 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const esmImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<Record<string, unknown>>;

/** Minimal structural view of the Pi SDK session methods we use. */
interface PiSdkSession {
  bindExtensions(bindings: Record<string, unknown>): Promise<void>;
  dispose(): void;
  readonly sessionId?: string;
}

/**
 * Resolve a Pi `Model` object from a `provider/model` string via pi-ai's
 * `getModel`. Returns `{ model }` on success, `{ fatal }` with an actionable
 * message on an invalid/unindexed model (getModel returns `undefined` — a plain
 * check, no throw), or `{}` when no model was requested (Pi uses its own default
 * — the 3a anthropic-default path).
 */
async function resolveModel(modelStr: string | undefined): Promise<{ model?: unknown; fatal?: string }> {
  if (!modelStr) return {};
  const slash = modelStr.indexOf('/');
  if (slash <= 0 || slash === modelStr.length - 1) {
    return { fatal: `Invalid Pi model "${modelStr}" — expected "provider/model" (e.g. anthropic/claude-opus-4-5).` };
  }
  const provider = modelStr.slice(0, slash);
  const modelName = modelStr.slice(slash + 1);
  try {
    const piAi = await esmImport(PI_AI_PACKAGE);
    const getModel = piAi.getModel as (p: string, m: string) => unknown;
    const model = getModel(provider, modelName);
    if (model === undefined || model === null) {
      return {
        fatal:
          `Pi model "${modelStr}" not found in Pi's provider index (provider="${provider}"). ` +
          `Check the model id against \`pi --list-models\` / models.dev.`,
      };
    }
    return { model };
  } catch (err) {
    return { fatal: `Failed to resolve Pi model "${modelStr}": ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface RunHeadlessPiOptions {
  config?: Config;
  toolAccess?: PiToolAccess;
  /** #700 (P2 / G) — durable guardrail posture; absent ⇒ autonomous. */
  guardrailPolicy?: GuardrailPolicy;
  /** `provider/model` selector; absent → Pi default. */
  model?: string;
  /** Restart-resume: prior Pi conversation id (A4 wires SessionManager). */
  continueSessionId?: string;
}

/**
 * Build the `DefaultResourceLoader` options for a headless Pi player.
 *
 * SECURITY — S2 (MD-C deny-list soundness). The `restricted` tool gate is a
 * DENY-LIST over shell/exec tool *names* (tool-capability.ts EXEC_TOOLS, via
 * `classify(name) === 'exec'` — F1 replaced extension.ts's former local set). That
 * guarantee — "restricted = no host execution" — holds ONLY IF no third-party
 * extension can register an un-blacklisted execution tool (e.g. a custom
 * `python` / `npm` / `run` tool). It therefore depends on a hard structural
 * fact: which extensions Pi loads.
 *
 * Verified against the installed Pi SDK 0.78 source (NOT assumed):
 *   - `DefaultResourceLoader.reload()` (resource-loader.js:271-276) builds
 *     `extensionPaths = noExtensions ? cliEnabledExtensions
 *                                     : merge(cliEnabledExtensions, enabledExtensions)`
 *     where `enabledExtensions` (line 229) are the DISK/package extensions from
 *     `packageManager.resolve()` (`~/.pi/agent/extensions/`, `<cwd>/.pi/extensions/`,
 *     installed packages). `loadExtensions(extensionPaths)` then loads them and
 *     MERGES with our inline factories (lines 274-276).
 *   - `noExtensions` defaults to `false` (constructor, line 132) — so the naive
 *     loader DOES load disk extensions. That is the S2 gap.
 *
 * Fix (= security's "exclude the extensions dir", done structurally):
 *   - `noExtensions: true` → `extensionPaths` collapses to `cliEnabledExtensions`,
 *     which is empty because we pass NO `additionalExtensionPaths`. So
 *     `loadExtensions([])` registers nothing from disk/packages.
 *   - Inline `extensionFactories` load UNCONDITIONALLY (reload() line 275 is not
 *     gated by `noExtensions`), so our agent-tempo extension still attaches.
 * Net: the ONLY tools present are Pi's built-ins (bash/read/edit/write/grep —
 * all covered by the deny-list) + our agent-tempo MCP tools (no exec). No
 * third-party tool can slip past the deny-list. Skills/prompts/themes cannot
 * register tools, so they are not a vector and are left at defaults.
 *
 * Kept as a pure, exported helper so the `noExtensions: true` invariant has a
 * unit regression test (test/pi-headless-loader.test.ts) without needing the Pi
 * SDK installed.
 */
/**
 * Pi BUILT-IN mutating ("act") tool names, excluded at registration for the
 * `observe-only` no-act posture (#715). Pi's default built-ins are
 * read/bash/edit/write; `multiedit` is listed defensively (a no-op if Pi doesn't
 * register it). `bash`/exec are covered by {@link EXEC_TOOLS}. We keep the READ
 * built-ins (read/grep/glob/ls). These are Pi BUILT-IN names — deliberately NOT
 * agent-tempo MCP tool names, so excluding them never removes an agent-tempo
 * coordination tool (those stay handler-gated, commit 5).
 */
const PI_BUILTIN_ACT_TOOLS: readonly string[] = ['write', 'edit', 'multiedit'];

/**
 * #715 — compute the registration-level `excludeTools` denylist for
 * `createAgentSession`. Excluded tools are never registered → ABSENT from the
 * model's toolset AND system prompt: the LLM cannot request what it never sees.
 *
 * This is a registration-level FLOOR beneath the call-time MD-C handler + #712
 * gate. It is tamper-RESISTANT, NOT tamper-PROOF: it defends a PROMPT-INJECTED
 * agent (and holds even if the call-time gate had a bug — the tool simply isn't
 * there), but it does NOT defend against PROCESS COMPROMISE — a tampered /
 * modified extension can re-register or un-exclude tools (this is OUR code
 * passing a denylist; an attacker who modifies the code/process bypasses it).
 * That residual is OS-sandbox + supply-chain integrity, tracked as #724.
 *
 * `excludeTools` is matched by NAME against BOTH Pi built-ins AND
 * extension-registered tools (incl. agent-tempo's MCP tools via `renderToPi`), so
 * this list contains ONLY Pi-built-in / exec names — never agent-tempo tool names
 * (`cue`/`report`/`recruit`/…). Posture:
 *   - `toolAccess === 'restricted'` → exclude {@link EXEC_TOOLS} (exec/bash
 *     registration-absent; a strict upgrade of the prior call-time block, and the
 *     headless default → the model never even sees exec).
 *   - `guardrailPolicy === 'observe-only'` → also exclude the Pi built-in act
 *     tools ({@link PI_BUILTIN_ACT_TOOLS}); read/grep/glob stay. The agent-tempo
 *     MCP act tools (recruit/destroy/…) stay covered by the client-side no-act
 *     handler (commit 5) — excludeTools handles the Pi built-ins only.
 *   - `monitored` / `supervised` / `autonomous` → NO exec exclusion: those tools
 *     stay REGISTERED so they can be gated/approved per-use (#712). (`supervised`
 *     = approve-and-run, NOT exec-absent.)
 *
 * Pure + exported so the registration-absence invariant has a unit regression
 * test without the Pi SDK (mirrors {@link buildPiResourceLoaderOptions}).
 */
export function computeExcludeTools(
  toolAccess: PiToolAccess,
  guardrailPolicy: GuardrailPolicy | undefined,
): string[] {
  const exclude = new Set<string>();
  if (toolAccess === 'restricted') {
    for (const t of EXEC_TOOLS) exclude.add(t);
  }
  if (guardrailPolicy === 'observe-only') {
    for (const t of EXEC_TOOLS) exclude.add(t); // no-act ⊇ no-exec
    for (const t of PI_BUILTIN_ACT_TOOLS) exclude.add(t);
  }
  return [...exclude];
}

export function buildPiResourceLoaderOptions(params: {
  cwd: string;
  agentDir: string;
  /** The inline agent-tempo extension factory (`createPiExtension(...)`). Typed
   *  with a bottom param so any concrete factory arity is assignable. */
  extensionFactory: (pi: never) => void;
}): Record<string, unknown> {
  return {
    cwd: params.cwd,
    agentDir: params.agentDir,
    extensionFactories: [params.extensionFactory],
    // SECURITY (S2): hard-exclude all disk/package extensions. Do NOT add
    // `additionalExtensionPaths` here — that would re-introduce the exec-tool
    // vector this flag closes.
    noExtensions: true,
  };
}

/**
 * Boot + run a headless Pi player until shutdown. Resolves when the process has
 * cleanly detached + disposed (it also calls process.exit on the terminal path).
 */
export async function runHeadlessPi(opts: RunHeadlessPiOptions = {}): Promise<void> {
  const config = opts.config ?? getConfig();
  const toolAccess: PiToolAccess = opts.toolAccess ?? 'restricted';

  // 0) Node-floor backstop (Decision B, #645). The recruit pre-flight is the
  //    AUTHORITATIVE gate; this covers direct/manual launches that bypass recruit.
  //    Checked before the SDK probe because Pi's ESM packages can't even import on
  //    sub-22.19 Node — a clean floor message beats a cryptic import failure.
  const nodeFloor = checkPiNodeFloor();
  if (!nodeFloor.ok) {
    log(`FATAL: ${nodeFloor.reason} Exiting.`);
    process.exit(3);
    return;
  }

  // 1) Probe — the spawn entry is the only place the Pi SDK is REQUIRED.
  if (!probeSdkInstall(PI_PACKAGE)) {
    log(`FATAL: ${PI_PACKAGE} is not installed — cannot run headless Pi. Exiting.`);
    process.exit(1);
    return;
  }

  // 2) Resolve the model BEFORE creating the session — a bad model fails clean
  //    (exit before attach, no half-attached orphan).
  const { model, fatal } = await resolveModel(opts.model);
  if (fatal) {
    log(`FATAL: ${fatal} Exiting without attaching.`);
    process.exit(2);
    return;
  }

  // 3) Inline extension factory — headless mode → the MD-C tool gate is active.
  //    #700 (P2 / G) — the guardrail posture drives the MD-G gate's failMode.
  const extensionFactory = createPiExtension({ mode: 'headless', toolAccess, guardrailPolicy: opts.guardrailPolicy });

  // 4) Construct the Pi SDK session with the extension injected inline.
  const piSdk = await esmImport(PI_PACKAGE);
  const createAgentSession = piSdk.createAgentSession as (o: Record<string, unknown>) => Promise<{ session: PiSdkSession }>;
  const DefaultResourceLoader = piSdk.DefaultResourceLoader as new (o: Record<string, unknown>) => { reload(): Promise<void> };

  // H1 (#645): ALWAYS run in-memory. A disk-backed SessionManager loads
  // ~/.pi/agent/sessions/<cwd>/*.jsonl on startup; a stale/partial entry with
  // malformed `content` throws "content is not iterable" during Pi's
  // compaction/consumption scan (agent-session.js:2486/2493). inMemory loads
  // nothing from disk → that crash vector is gone. `sessionManager` and
  // `resourceLoader` are INDEPENDENT createAgentSession options (no conflict with
  // the noExtensions/reload() path above).
  const SessionManager = piSdk.SessionManager as { inMemory(cwd?: string): unknown };
  const sessionManager = SessionManager.inMemory(process.cwd());
  // Single appendMessage chokepoint (session-seed.ts). For a fresh recruit the
  // transcript is empty → no-op; H2 supplies the durable replay read here
  // (fetch_state on ENV.PI_CONTINUE_SESSION). headless.ts NEVER calls
  // appendMessage directly — sanitization is the only crash lever we control.
  seedSessionManager(sessionManager as SeedableSessionManager, undefined /* H2: durable replay transcript */);
  // Pi's DefaultResourceLoader REQUIRES agentDir (normalizePath does
  // `.startsWith()` on it) — getAgentDir() resolves ~/.pi/agent. Pass it to BOTH
  // createAgentSession and the loader. (Found in the 3a live smoke — devops.)
  const getAgentDir = piSdk.getAgentDir as () => string;
  const agentDir = getAgentDir();

  const resourceLoader = new DefaultResourceLoader(
    buildPiResourceLoaderOptions({ cwd: process.cwd(), agentDir, extensionFactory }),
  );
  // CRITICAL (3a live smoke — devops): createAgentSession only calls
  // resourceLoader.reload() when IT constructs the loader (sdk.js:99-101). When we
  // pass our OWN loader, reload() is skipped — and DefaultResourceLoader inits
  // `extensionsResult.extensions = []` (resource-loader.js:146) and only populates
  // it during reload(). So without this explicit reload our extension never
  // registers, and session_start fires into an empty handler list (no claim, no
  // heartbeat). The SDK's own doc comment (sdk.js:74-83) prescribes this exact
  // construct → reload() → pass-as-resourceLoader sequence.
  await resourceLoader.reload();

  // #715 — registration-level exec/act exclusion (the true "agent physically
  // lacks the tools" boundary; see computeExcludeTools). Excluded tools are never
  // registered, so they're absent from the model's toolset + system prompt — a
  // hard layer beyond the call-time MD-C handler + #712 gate (kept as
  // belt-and-suspenders). Empty for monitored/supervised/autonomous+standard.
  const excludeTools = computeExcludeTools(toolAccess, opts.guardrailPolicy);
  if (excludeTools.length > 0) {
    log(`#715: excluding ${excludeTools.length} tool(s) at registration (toolAccess=${toolAccess}, guardrailPolicy=${opts.guardrailPolicy ?? 'autonomous'}): ${excludeTools.join(', ')}`);
  }
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir,
    ...(model ? { model } : {}),
    ...(excludeTools.length > 0 ? { excludeTools } : {}),
    resourceLoader,
    // H1 (#645): in-memory session (seeded above via the session-seed chokepoint).
    // H2 will seed it from agent-tempo durable state (ENV.PI_CONTINUE_SESSION
    // saveable-state key) before this call — a true continuation, not a cue.
    sessionManager,
  });

  // 5) Explicit bootstrap — fires session_start → the singleton claims/attaches.
  await session.bindExtensions({});
  // Headless session_start carries NO `session` field (interactive does), so the
  // extension can't wire the cue pump's session ref itself. We hold the SDK
  // session here — set it on the now-claimed runtime so the cue pump can inject.
  // (3a live smoke — devops; the headless-vs-interactive session-wiring gap.)
  const playerId = process.env[ENV.PLAYER_NAME] || `pi-${process.pid}`;
  setRuntimeSession(sessionWorkflowId(config.ensemble, playerId), session as unknown as PiAgentSession);
  log(
    `headless Pi session bound (toolAccess=${toolAccess}, ` +
    `model=${opts.model ?? 'pi-default'}${opts.continueSessionId ? `, continue=${opts.continueSessionId}` : ''}, ` +
    `sessionId=${session.sessionId ?? '?'})`,
  );

  // 6) Stay alive until a shutdown signal, then RELIABLE detach → dispose → exit.
  // Keep the event loop alive with a REF'd timer: the heartbeat + cue-pump timers
  // are `.unref()`'d by design (so they never block a clean exit), and the
  // SIGTERM/SIGINT once-listeners aren't active handles — so WITHOUT this the loop
  // drains and Node exits code 0 immediately after bindExtensions in headless mode.
  // (Found in the 3a live smoke — devops.)
  const keepAlive = setInterval(() => { /* hold the loop */ }, 30_000);
  try {
    await new Promise<void>((resolveShutdown) => {
      const onSignal = (sig: string) => { log(`received ${sig} — shutting down`); resolveShutdown(); };
      process.once('SIGTERM', () => onSignal('SIGTERM'));
      process.once('SIGINT', () => onSignal('SIGINT'));
    });
  } finally {
    clearInterval(keepAlive);
  }

  // Headless owns the exit sequence: await adapterExited (unmaps the runtime)
  // THEN dispose the SDK session (the dispose-fired session_shutdown finds no
  // mapped runtime → no-op, so no double-detach).
  try { await detachAllPiRuntimesForExit(); } catch (err) { log('detach failed (reaper backstops):', err); }
  try { session.dispose(); } catch (err) { log('dispose failed:', err); }
  log('headless Pi clean-exit complete');
  // eslint-disable-next-line no-process-exit
  process.exit(0);
}
