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
import { getConfig, type Config } from '../config';
import { probeSdkInstall } from '../utils/sdk-probe';
import { createPiExtension, detachAllPiRuntimesForExit, type PiToolAccess } from './extension';
import { PI_PACKAGE, PI_AI_PACKAGE } from './probe';

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
  /** `provider/model` selector; absent → Pi default. */
  model?: string;
  /** Restart-resume: prior Pi conversation id (A4 wires SessionManager). */
  continueSessionId?: string;
}

/**
 * Boot + run a headless Pi player until shutdown. Resolves when the process has
 * cleanly detached + disposed (it also calls process.exit on the terminal path).
 */
export async function runHeadlessPi(opts: RunHeadlessPiOptions = {}): Promise<void> {
  const config = opts.config ?? getConfig();
  const toolAccess: PiToolAccess = opts.toolAccess ?? 'restricted';

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
  const extensionFactory = createPiExtension({ mode: 'headless', toolAccess });

  // 4) Construct the Pi SDK session with the extension injected inline.
  const piSdk = await esmImport(PI_PACKAGE);
  const createAgentSession = piSdk.createAgentSession as (o: Record<string, unknown>) => Promise<{ session: PiSdkSession }>;
  const DefaultResourceLoader = piSdk.DefaultResourceLoader as new (o: Record<string, unknown>) => unknown;

  const { session } = await createAgentSession({
    cwd: process.cwd(),
    ...(model ? { model } : {}),
    resourceLoader: new DefaultResourceLoader({
      cwd: process.cwd(),
      extensionFactories: [extensionFactory],
    }),
    // NOTE (A4): restart-resume via a SessionManager seeded from
    // opts.continueSessionId / ENV.PI_CONTINUE_SESSION lands in A4; 3a proves the
    // loop on a fresh session.
  });

  // 5) Explicit bootstrap — fires session_start → the singleton claims/attaches.
  await session.bindExtensions({});
  log(
    `headless Pi session bound (toolAccess=${toolAccess}, ` +
    `model=${opts.model ?? 'pi-default'}${opts.continueSessionId ? `, continue=${opts.continueSessionId}` : ''}, ` +
    `sessionId=${session.sessionId ?? '?'})`,
  );

  // 6) Stay alive until a shutdown signal, then RELIABLE detach → dispose → exit.
  await new Promise<void>((resolveShutdown) => {
    const onSignal = (sig: string) => { log(`received ${sig} — shutting down`); resolveShutdown(); };
    process.once('SIGTERM', () => onSignal('SIGTERM'));
    process.once('SIGINT', () => onSignal('SIGINT'));
  });

  // Headless owns the exit sequence: await adapterExited (unmaps the runtime)
  // THEN dispose the SDK session (the dispose-fired session_shutdown finds no
  // mapped runtime → no-op, so no double-detach).
  try { await detachAllPiRuntimesForExit(); } catch (err) { log('detach failed (reaper backstops):', err); }
  try { session.dispose(); } catch (err) { log('dispose failed:', err); }
  log('headless Pi clean-exit complete');
  // eslint-disable-next-line no-process-exit
  process.exit(0);
}
