/**
 * Help-text module for `claude-tempo help` / `--help` / `-h`.
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

export function printHelp(): void {
  console.log(`
${out.bold('claude-tempo')} — Multi-session Claude Code coordination via Temporal

${out.bold('Getting started:')}
  ${out.cyan('claude-tempo up')}                  Set up everything and launch a conductor

${out.bold('Usage:')}
  claude-tempo <command> [options]

${out.bold('Commands:')}
  ${out.cyan('up')}      [ensemble]    First-time setup: start Temporal, configure MCP, launch conductor
  ${out.cyan('down')}    [ensemble]    Tear down everything: sessions, daemon, Temporal server, MCP config
  ${out.cyan('server')}                Start the Temporal dev server and register search attributes
  ${out.cyan('conduct')} [ensemble]    Start a conductor session (resumes existing, --replace to restart)
  ${out.cyan('start')}   [ensemble]    Start a player session
  ${out.cyan('stop')}    [ensemble]    Stop sessions (-n <name> for one, or --all)
  ${out.cyan('status')}  [ensemble]    Show active sessions and Temporal health
  ${out.cyan('ensemble')} <sub>       Manage saved ensemble lineups (save/list/show)
  ${out.cyan('broadcast')} <message>   Send a message to all active players
  ${out.cyan('restart')} <name>        Restart a session (reap + claim + context replay + spawn)
  ${out.cyan('detach')} <name>         Gracefully reap a session's adapter (workflow survives)
  ${out.cyan('destroy')} <name>        Terminally end a session workflow
  ${out.cyan('migrate')} <name> --host Move a session to a different host
  ${out.cyan('attachment-info')} <name> Inspect the V2 attachment phase + current holder
  ${out.cyan('restore')} [name]         Restore orphaned session(s) — interactive picker, or --all / --from-host / --dry-run
  ${out.cyan('release')} [ensemble]   Release all held players (unlock outbox, deliver messages)
  ${out.cyan('pause')}   [ensemble]   Pause an ensemble (sessions, scheduler, maestro)
  ${out.cyan('resume')}  [ensemble]   Resume a paused ensemble (add --release to also release held sessions)
  ${out.cyan('agent-types')} <sub>    Manage player type definitions (list/show/init)
  ${out.cyan('daemon')}    <sub>       Manage the worker daemon (start/stop/status/logs)
  ${out.cyan('upgrade')}  [version]    Upgrade claude-tempo to latest (or specific version)
  ${out.cyan('config')}                Configure Temporal connection settings
  ${out.cyan('init')}                  Register MCP server globally (or --project for .mcp.json)
  ${out.cyan('preflight')}             Run preflight checks only
  ${out.cyan('help')}                  Show this help message

${out.bold('Connection options (all commands):')}
  --temporal-address <addr>    Temporal server address (default: localhost:7233)
  --temporal-namespace <ns>    Temporal namespace (default: default)
  --temporal-api-key <key>     Temporal API key (for Temporal Cloud)
  --temporal-tls-cert <path>   Path to TLS client certificate
  --temporal-tls-key <path>    Path to TLS client key

${out.bold('Other options:')}
  -n, --name <name>           Set the session window name (start/conduct/up only)
  --agent <claude|copilot>    Agent type to spawn (default: from config; start/conduct)
  --skip-preflight            Skip preflight checks (start/conduct only)
  --background                Run Temporal in background (server only)
  --project                   Use per-project .mcp.json instead of global (init only)
  --keep-mcp                  Don't remove MCP config (down only)
  --keep-daemon               Don't stop the worker daemon (down only)
  -y, --yes                   Skip confirmation prompt (down only)
  --all                       Stop all sessions (stop only)
  --lineup <name|file>        Load ensemble lineup by name or file path (up/conduct)
  --no-hold                   Skip startup hold (requires --lineup on up/conduct)
  --ensemble <name>           Target a specific ensemble (stop/down)
  -d, --dir <path>            Target directory (default: cwd)

${out.bold('Config command:')}
  ${out.dim('claude-tempo config')}              Interactive connection setup
  ${out.dim('claude-tempo config show')}         Show resolved config
  ${out.dim('claude-tempo config set <k> <v>')}  Set a config value

  Settings are saved to ~/.claude-tempo/config.json.
  Also reads ~/.config/temporalio/temporal.yaml as a fallback.

  ${out.bold('Resolution order:')} CLI flag > env var > config file > temporal CLI config > default

${out.bold('First time? Run this:')}
  ${out.dim('cd your-project')}
  ${out.dim('claude-tempo up')}

${out.bold('Typical workflow:')}
  ${out.dim('claude-tempo server')}               Start Temporal (once, keep running)
  ${out.dim('claude-tempo conduct myband')}       Start a conductor
  ${out.dim('claude-tempo start myband')}         Add player sessions
  ${out.dim('claude-tempo start myband --agent copilot -n copilot-1')}   Add a Copilot player
  ${out.dim('claude-tempo status myband')}        Check who's active

${out.bold('Environment:')}
  CLAUDE_TEMPO_ENSEMBLE       Default ensemble name (fallback: "default")
  TEMPORAL_ADDRESS            Default Temporal address (fallback: localhost:7233)
  TEMPORAL_NAMESPACE          Default Temporal namespace (fallback: "default")
  TEMPORAL_API_KEY            Temporal API key
  TEMPORAL_TLS_CERT_PATH      Path to TLS client certificate
  TEMPORAL_TLS_KEY_PATH       Path to TLS client key
  CLAUDE_TEMPO_DEFAULT_AGENT  Default agent type: claude or copilot (fallback: claude)
`);
}
