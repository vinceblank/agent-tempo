/**
 * Help-text module for `agent-tempo help` / `--help` / `-h`.
 *
 * **Critical constraint**: this module must NOT import from `@temporalio/*`,
 * `../workflows/*`, `../adapters/*`, `../spawn`, `../client`, `./commands`,
 * `./preflight`, `./config-command`, or any module that transitively pulls in
 * the Temporal SDK. The `help` command must remain operable when the Temporal
 * SDK itself is broken (see issue #157 PR C — users need to be able to read
 * help to find the recovery path).
 *
 * Kept in its own file (instead of inlined in `src/cli.ts`) so the static
 * help string doesn't bloat the CLI entrypoint. The test
 * `test/cli-crash-proof-isolation.test.ts` enumerates this module and asserts
 * its `require.cache` has no Temporal-adjacent leaks.
 */
import * as out from './output';
import { AGENT_TYPES } from '../types';

// `AGENT_TYPES` lives in `src/types.ts`, which the crash-proof contract
// (#157) explicitly permits — it's pure-types-only with no `@temporalio/*`
// imports. Composing the help string from the canonical tuple means
// adding a new adapter automatically updates this surface.
const AGENT_OPTIONS = AGENT_TYPES.join('|');

export function printHelp(): void {
  console.log(`
${out.bold('agent-tempo')} — Multi-session Claude Code coordination via Temporal

${out.bold('Getting started:')}
  ${out.cyan('agent-tempo up')}                  Start infrastructure, then run ${out.dim('agent-tempo')} for status + operator hints

${out.bold('Usage:')}
  agent-tempo                         Auto-provision, show status, and print operator hints
  agent-tempo <ensemble>              Same, scoped to one ensemble's status
  agent-tempo <command> [options]

${out.bold('Commands:')}
  ${out.cyan('home')}                     Bare landing (default): auto-provision, show status, print operator hints
  ${out.cyan('up')}                       Start infrastructure only — Temporal, daemon, MCP registration
  ${out.cyan('down')}                     Stop infrastructure; workflows stay parked for the next ${out.dim('up')}
  ${out.cyan('down --destroy [-y]')}      Terminate every workflow across every ensemble, then stop infrastructure
  ${out.cyan('server')}                   Start the Temporal dev server and register search attributes
  ${out.cyan('status')}  [ensemble]       Show active sessions and Temporal health
  ${out.cyan('ensemble')} <sub>           Manage saved ensemble lineups (save/list/show)
  ${out.cyan('broadcast')} <message>      Send a message to all active players
  ${out.cyan('destroy')} <ensemble> [-y]  Terminate every workflow in one ensemble (typed confirmation)
  ${out.cyan('attachment-info')} <name>   Inspect the V2 attachment phase + current holder
  ${out.cyan('recall')} <name>            Read a player's message history (--limit/--offset/--preview/--from/--since/--include-sent/--json)
  ${out.cyan('hosts')}                    List daemons polling this Temporal namespace with advertised capabilities (--all/--json)
  ${out.cyan('refresh-host-profile')}     Re-advertise this daemon's capability profile to the global Maestro
  ${out.cyan('restore')} <ensemble>       Restore orphaned sessions in one ensemble on this host (--all-hosts for cluster-view listing)
  ${out.cyan('release')} [ensemble]       Release all held players (unlock outbox, deliver messages)
  ${out.cyan('agent-types')} <sub>        Manage player type definitions (list/show/init)
  ${out.cyan('daemon')}    <sub>          Manage the worker daemon (start/stop/status/logs)
  ${out.cyan('dashboard')}                Open the web dashboard (--no-open / --pair / --json)
  ${out.cyan('command-center')} [ensemble] Launch the interactive Pi mission-control board (operator seat; alias: cc/board)
  ${out.cyan('upgrade')}  [version]       Upgrade agent-tempo to latest (or specific version)
  ${out.cyan('upgrade-to-2')}             Cut over 1.x → 2.0: pause, drain, snapshot, then destroy all workflows (--dry-run / --yes / --force-drain)
  ${out.cyan('config')}                   Configure Temporal connection settings
  ${out.cyan('init')}                     Register MCP server globally (or --project for .mcp.json)
  ${out.cyan('install-pi')}               Install the Pi extensions into Pi settings (or --project for .pi/settings.json)
  ${out.cyan('preflight')}                Run preflight checks only
  ${out.cyan('version')}                  Print the installed version (alias: --version, -v)
  ${out.cyan('help')}                     Show this help message

${out.bold('Removed — use the command-center board')} ${out.dim('(agent-tempo command-center)')}:
  ${out.dim('stop / restart / detach / migrate')}   → ${out.dim('/destroy · /restart · /shutdown · /migrate')}
  ${out.dim('conduct / start / recruit / disband')} → ${out.dim('agent-tempo up · /recruit · /destroy')}
  ${out.dim('resume / tui')}                        → ${out.dim('/play · run `agent-tempo` (status) or `command-center` (board)')}
  See https://github.com/vinceblank/agent-tempo/issues/285 for the full migration table.

${out.bold('Connection options (all commands):')}
  --temporal-address <addr>    Temporal server address (default: localhost:7233)
  --temporal-namespace <ns>    Temporal namespace (default: default)
  --temporal-api-key <key>     Temporal API key (for Temporal Cloud)
  --temporal-tls-cert <path>   Path to TLS client certificate
  --temporal-tls-key <path>    Path to TLS client key

${out.bold('Other options:')}
  --name <name>                Set session window name (up only)
  --agent <name>               Agent type to spawn — ${AGENT_OPTIONS} (default: from config; up)
  --dev                        Use the dev profile (~/.agent-tempo-dev, port 8474, namespace agent-tempo-dev)
  --skip-preflight             Skip preflight checks
  --background                 Run Temporal in background (server only)
  --project                    Use per-project .mcp.json instead of global (init only)
  --keep-mcp                   Don't remove MCP config (down only)
  --keep-daemon                Don't stop the worker daemon (down only)
  --destroy                    Also terminate every workflow (down only)
  --kill-shared-temporal       Tear down the Temporal dev server even if the other profile is active (down only, #423)
  -y, --yes                    Skip confirmation prompt (down --destroy, destroy, upgrade-to-2)
  --force-drain                Proceed past a non-empty outbox drain, recording stragglers in the snapshot (upgrade-to-2, #785)
  --lineup <name|file>         Load ensemble lineup by name or file path (up)
  --scenario <name|path>       Force every mock player in the lineup into mockMode:scripted with this scenario (dev-mode-only, up + --lineup)
  --no-hold                    Skip startup hold (requires --lineup on up)
  --ensemble <name>            Target a specific ensemble (broadcast, destroy, restore)
  --all-hosts                  List cross-host orphans across the whole namespace (restore — read-only, #151)
  -d, --dir <path>             Target directory (default: cwd)

${out.bold('Config command:')}
  ${out.dim('agent-tempo config')}              Interactive connection setup
  ${out.dim('agent-tempo config show')}         Show resolved config
  ${out.dim('agent-tempo config set <k> <v>')}  Set a config value

  Settings are saved to ~/.agent-tempo/config.json.
  Also reads ~/.config/temporalio/temporal.yaml as a fallback.

  ${out.bold('Resolution order:')} CLI flag > env var > config file > temporal CLI config > default

${out.bold('First time? Run this:')}
  ${out.dim('cd your-project')}
  ${out.dim('agent-tempo up')}
  ${out.dim('agent-tempo')}            # Launch the TUI

${out.bold('Typical workflow:')}
  ${out.dim('agent-tempo up')}                 Start infrastructure (once per host)
  ${out.dim('agent-tempo')}                    Launch the TUI
  ${out.dim('agent-tempo status myband')}      Check who's active in an ensemble

${out.bold('Environment:')}
  AGENT_TEMPO_ENSEMBLE       Default ensemble name (fallback: "default")
  TEMPORAL_ADDRESS            Default Temporal address (fallback: localhost:7233)
  TEMPORAL_NAMESPACE          Default Temporal namespace (fallback: "default")
  TEMPORAL_API_KEY            Temporal API key
  TEMPORAL_TLS_CERT_PATH      Path to TLS client certificate
  TEMPORAL_TLS_KEY_PATH       Path to TLS client key
  AGENT_TEMPO_DEFAULT_AGENT  Default agent type: claude or copilot (fallback: claude)
  AGENT_TEMPO_DEV_MODE       Set to "1" or "true" to enable the dev profile (alternative to --dev)
  AGENT_TEMPO_HOME_OVERRIDE  Override the home dir entirely (escape hatch for triple-isolated envs)
`);
}
