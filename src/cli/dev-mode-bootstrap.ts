/**
 * Pre-import side-effect that promotes a top-level `--dev` CLI flag into
 * `CLAUDE_TEMPO_DEV_MODE=1` BEFORE any other module loads (ADR 0014 §5.4).
 *
 * **Why this file exists**: `src/cli.ts` imports `./config` statically, and
 * `src/config.ts` evaluates `CLAUDE_TEMPO_HOME = resolveTempoHome()` at
 * module load time. By the time the main argv parser runs, that constant
 * has already been frozen against `~/.claude-tempo/`. The bootstrap mutates
 * `process.env` early — before the static `./config` import resolves — so
 * the dev profile lights up everywhere downstream consistently.
 *
 * Imported as the very first statement of `src/cli.ts`. Has zero imports
 * (not even `./config`) so it can run before any other module loads. This
 * file MUST stay dependency-free; if you find yourself wanting to import
 * something here, put it in `src/cli/dev-banner.ts` instead.
 *
 * Side effects:
 *   1. If `--dev` appears anywhere in `process.argv`, set
 *      `process.env.CLAUDE_TEMPO_DEV_MODE='1'`.
 *   2. Strip `--dev` from `process.argv` so the main parser doesn't reject
 *      it as unknown.
 *
 * Daemon child processes inherit `CLAUDE_TEMPO_DEV_MODE` automatically via
 * `spawn(..., { env: { ...process.env } })` in `src/cli/daemon.ts`. Users
 * can also bypass the flag entirely by setting `CLAUDE_TEMPO_DEV_MODE=1`
 * directly in their shell — useful for MCP server processes that aren't
 * launched via the CLI.
 */

const DEV_FLAG = '--dev';

const idx = process.argv.indexOf(DEV_FLAG);
if (idx !== -1) {
  process.env.CLAUDE_TEMPO_DEV_MODE = '1';
  process.argv.splice(idx, 1);
}

// Empty export keeps this as a module rather than a script. Side-effect
// imports (`import './dev-mode-bootstrap'`) work either way; the export
// just signals the file's "TypeScript module" status to the language server.
export {};
