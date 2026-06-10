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
import { createPiExtension, detachAllPiRuntimesForExit, setRuntimeSession } from './extension';
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
  /** `provider/model` selector; absent → Pi default. */
  model?: string;
  /** Restart-resume: prior Pi conversation id (A4 wires SessionManager). */
  continueSessionId?: string;
}

/**
 * Build the `DefaultResourceLoader` options for a headless Pi player.
 *
 * SECURITY — S2 (supply-chain hygiene). A daemon-spawned headless player must
 * load ONLY the inline agent-tempo extension — never arbitrary disk/package
 * extensions (`~/.pi/agent/extensions/`, `<cwd>/.pi/extensions/`, installed
 * packages), which would let unreviewed third-party code run inside a recruited
 * player's process.
 *
 * Verified against the installed Pi SDK 0.78 source (NOT assumed):
 *   - `DefaultResourceLoader.reload()` (resource-loader.js:271-276) builds
 *     `extensionPaths = noExtensions ? cliEnabledExtensions
 *                                     : merge(cliEnabledExtensions, enabledExtensions)`
 *     where `enabledExtensions` (line 229) are the DISK/package extensions from
 *     `packageManager.resolve()`. `loadExtensions(extensionPaths)` then loads
 *     them and MERGES with our inline factories (lines 274-276).
 *   - `noExtensions` defaults to `false` (constructor, line 132) — so the naive
 *     loader DOES load disk extensions. That is the S2 gap.
 *
 * Fix (done structurally):
 *   - `noExtensions: true` → `extensionPaths` collapses to `cliEnabledExtensions`,
 *     which is empty because we pass NO `additionalExtensionPaths`. So
 *     `loadExtensions([])` registers nothing from disk/packages.
 *   - Inline `extensionFactories` load UNCONDITIONALLY (reload() line 275 is not
 *     gated by `noExtensions`), so our agent-tempo extension still attaches.
 * Net: the ONLY tools present are Pi's built-ins + our agent-tempo MCP tools.
 * Skills/prompts/themes cannot register tools, so they are not a vector and are
 * left at defaults.
 *
 * Kept as a pure, exported helper so the `noExtensions: true` invariant has a
 * unit regression test (test/pi-headless-loader.test.ts) without needing the Pi
 * SDK installed.
 */
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

  // 3) Inline extension factory — headless mode.
  const extensionFactory = createPiExtension({ mode: 'headless' });

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

  const { session } = await createAgentSession({
    cwd: process.cwd(),
    agentDir,
    ...(model ? { model } : {}),
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
    `headless Pi session bound (` +
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
