/**
 * CLI `--agent` parser allowlist tests (#476).
 *
 * Pre-#476 the argv parser hardcoded `'claude' | 'copilot'` and rejected
 * every other value, even though `AgentType` had grown to include `'mock'`
 * (#220) and `'claude-api'` (#131). The bug was latent — only fired when
 * users invoked the CLI directly (`agent-tempo recruit --agent claude-api`).
 *
 * The fix sources the allowlist from the canonical `AGENT_TYPES` tuple in
 * `src/types.ts` so the CLI tracks the union automatically. These tests
 * pin one case per valid agent type so future drift breaks here loud and
 * early — adding a new adapter without updating `AGENT_TYPES` lights up
 * a red test rather than silently rejecting at runtime.
 *
 * The tests spawn the real CLI as a subprocess (mirroring the `--limit`
 * cap test in `test/cli-recall.test.ts`) so we exercise the production
 * `process.exit(1)` path. Validation happens in `parseArgs` before any
 * Temporal connection — safe to run without a dev server.
 */
import { expect } from 'chai';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { AGENT_TYPES } from '../src/types';

// Mirrors `test/cli-recall.test.ts` — `__dirname` at runtime is
// `<repo>/dist-test/test`, repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_ENTRY = path.join(REPO_ROOT, 'dist', 'cli.js');

function runCli(...args: string[]) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 8_000,
    env: {
      ...process.env,
      // Suppress the dev-mode banner if a developer happens to have
      // AGENT_TEMPO_DEV_MODE exported in their shell — keeps the
      // stderr assertions deterministic.
      AGENT_TEMPO_DEV_MODE: '0',
    },
  });
}

describe('CLI --agent parser allowlist (#476)', function () {
  this.timeout(10_000);

  it('AGENT_TYPES is the canonical source — adding a new adapter must update it', function () {
    // Tripwire: if a future contributor edits the AgentType union without
    // also editing AGENT_TYPES, this assertion catches the drift before
    // the CLI parser does. The runtime tuple drives both the type and the
    // CLI allowlist; they cannot diverge by construction.
    expect(AGENT_TYPES).to.have.members(['claude', 'copilot', 'mock', 'claude-api', 'opencode', 'claude-code-headless']);
    expect(AGENT_TYPES.length).to.equal(6);
  });

  // One case per valid agent type — pins the allowlist surface so adding
  // a new adapter to `AGENT_TYPES` without ALSO editing this list lights
  // up a red test. (The reverse — removing an adapter — also surfaces
  // here.) The CLI parser's `else if` chain accepts the value before any
  // verb dispatch, so the subprocess exits at a downstream parser/runtime
  // boundary rather than the `--agent` validator. We assert the rejection
  // message is NOT present.
  for (const agent of AGENT_TYPES) {
    it(`accepts --agent ${agent} (passes the validator)`, function () {
      // `recall` is a Temporal-touching verb, so the subprocess will
      // ultimately error out trying to reach the daemon — but the
      // `--agent` validator runs in `parseArgs` before that, so the
      // stderr we care about is "Invalid agent type". Asserting its
      // absence is the right signal.
      const result = runCli('recall', 'tempo-eng', '--agent', agent);
      expect(result.stderr).to.not.include('Invalid agent type');
    });
  }

  it('rejects unknown --agent value with the new allowlist message', function () {
    const result = runCli('recall', 'tempo-eng', '--agent', 'gpt-4');
    expect(result.status).to.equal(1, `expected exit 1; got ${result.status}; stderr=${result.stderr}`);
    // The error must enumerate the full allowlist so operators know what
    // values are acceptable. Pre-#476 it said "claude" or "copilot"; the
    // post-fix message lists every member of AGENT_TYPES.
    expect(result.stderr).to.include('Invalid agent type: "gpt-4"');
    for (const agent of AGENT_TYPES) {
      expect(result.stderr).to.include(agent);
    }
  });

  it('rejects empty --agent value (no advance past the flag)', function () {
    // `--agent` without a following token: the parser's
    // `i + 1 < argv.length` guard treats it as "no value", so the flag is
    // silently ignored rather than erroring. The next behaviour we DO want
    // is that an explicit empty string `--agent ""` rejects, since the
    // value loop sees a token and validates it.
    const result = runCli('recall', 'tempo-eng', '--agent', '');
    expect(result.status).to.equal(1);
    expect(result.stderr).to.include('Invalid agent type');
  });
});
