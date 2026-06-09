/**
 * `agent-tempo command-center` (#729) — launch an interactive Pi mission-control
 * board for an ensemble.
 *
 * The board is the OPERATOR seat: it observes the ensemble (coarse SSE) and POSTs
 * operator actions (cue/pause/restart/gate/…) to the daemon's write/gate surface.
 * It is NOT a player — it never claims attachment or registers as an ensemble
 * member.
 *
 * The deliberate launch path (#729 A2): this sets `AGENT_TEMPO_MISSION_CONTROL=1`
 * so {@link resolvePiRole} resolves `'command-center'`, which activates the
 * mission-control extension and keeps the player extension dormant — exactly one
 * of the two auto-loaded Pi extensions registers tools, so their `cue`/`recruit`
 * names can't collide. It MUST NOT set `PLAYER_NAME`/`CONDUCTOR` (those flip the
 * role to player). A bare `pi` (neither signal) keeps BOTH dormant — plain coding
 * sessions stay pristine.
 */
import { CliOverrides, ENV, getConfig, isDevMode } from '../config';
import { buildPiCommandCenterSpawn, launchInTerminal } from '../spawn';
import { checkPiNodeFloor } from '../pi/probe';
import * as out from './output';

export interface CommandCenterArgs extends CliOverrides {
  /** Ensemble to observe (positional / `--ensemble`); falls back to config default. */
  ensemble?: string;
}

/**
 * Public entry point — invoked by the CLI dispatcher. Launches the board in a
 * real terminal (Pi only attaches its UI in a TTY) and returns; exits 1 on a
 * fail-clean preflight error.
 */
export async function commandCenterCommand(args: CommandCenterArgs): Promise<void> {
  const config = getConfig(args);
  const ensemble = config.ensemble;

  // Preflight — fail BEFORE launching a terminal that would die. checkPiNodeFloor
  // is a best-effort Node-version proxy; buildPiCommandCenterSpawn's default
  // resolver throws fail-clean when the Pi CLI is missing.
  const nodeFloor = checkPiNodeFloor();
  if (!nodeFloor.ok) {
    out.error(`Cannot start command-center — ${nodeFloor.reason}`);
    process.exit(1);
  }

  // Admin (T3) token — mission-control's operator write/gate surface reads it.
  // #54: a LOCAL (loopback) daemon grants full trust tokenless, so a tokenless
  // board is fully functional locally; only a REMOTE / 0.0.0.0 daemon requires the
  // token. Informational (not a warning, not a block) — accurate to the daemon's
  // own auth posture.
  const adminToken = process.env[ENV.HTTP_ADMIN_TOKEN];
  if (!adminToken) {
    out.log(
      out.dim(
        `  ${ENV.HTTP_ADMIN_TOKEN} not set — fine for a local (loopback) daemon (full trust). ` +
        'Set it only if this board drives a remote / 0.0.0.0 daemon.',
      ),
    );
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    out.warn(
      'ANTHROPIC_API_KEY is not set — the Pi command-center will fall back to Pi\'s own auth/default model.',
    );
  }

  const temporalEnvVars: Record<string, string> = {
    [ENV.TEMPORAL_ADDRESS]: config.temporalAddress,
    [ENV.TEMPORAL_NAMESPACE]: config.temporalNamespace,
  };
  if (config.temporalApiKey) temporalEnvVars[ENV.TEMPORAL_API_KEY] = config.temporalApiKey;
  if (config.temporalTlsCertPath) temporalEnvVars[ENV.TEMPORAL_TLS_CERT_PATH] = config.temporalTlsCertPath;
  if (config.temporalTlsKeyPath) temporalEnvVars[ENV.TEMPORAL_TLS_KEY_PATH] = config.temporalTlsKeyPath;

  let spawn: { cmd: string; args: string[]; env: Record<string, string> };
  try {
    spawn = buildPiCommandCenterSpawn({
      ensemble,
      temporalEnvVars,
      taskQueue: config.taskQueue,
      devMode: isDevMode(),
      ...(adminToken ? { adminToken } : {}),
      ...(process.env.ANTHROPIC_API_KEY ? { anthropicApiKey: process.env.ANTHROPIC_API_KEY } : {}),
    });
  } catch (err) {
    out.error(`Cannot start command-center — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const { pid } = launchInTerminal(spawn.cmd, spawn.args, process.cwd(), spawn.env);
  out.success(`Command-center launched for ensemble ${out.cyan(ensemble)} (pid ${pid ?? 'unknown'})`);
  out.log(`  ${out.dim('Observer-only Pi board — the player extension stays dormant in this session.')}`);
  out.log(`  ${out.dim('Requires `agent-tempo install-pi` to have registered the extensions.')}`);
}
