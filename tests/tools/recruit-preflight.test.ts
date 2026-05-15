/**
 * Parametrized recruit pre-flight gate coverage (#532).
 *
 * Closes the long-standing gap where the four SDK-class adapters'
 * pre-flight gates in `src/tools/recruit.ts` had no direct unit tests.
 * Adds the **copilot** gate from #532 and locks down the existing
 * **claude-api** / **opencode** / **claude-code-headless** gates as
 * regression tripwires, all in a single parametrized harness.
 *
 * Why parametrize: the four gates share an identical contract surface —
 * `agent === <name> && !host && !force` → fail with an actionable npm
 * install / env-var hint mentioning `force: true`. Copy-pasting one
 * `describe` per adapter would let drift creep in (e.g. some gates
 * mention the bypass hint, some don't). One table-driven harness keeps
 * the contract uniform.
 *
 * What's NOT covered (out of scope for this PR):
 *   - The opencode `hasOpencodeOnPath()` second probe is internal to
 *     `recruit.ts` (uses `spawnSync`) and isn't easily mockable without
 *     a fresh DI seam. We test the SDK-miss branch only — that's the
 *     branch shared with copilot/opencode parity.
 *   - The claude-api `require.resolve('@anthropic-ai/sdk')` SDK-miss
 *     branch needs the optional dep to actually be uninstalled, which
 *     can't be flipped per-test in vitest without monkey-patching the
 *     loader. We test the env-var branch instead — that's the FIRST
 *     check in the gate, so it covers the common "user forgot
 *     ANTHROPIC_API_KEY" failure mode.
 *
 * Failure-mode philosophy: each adapter's "missing" path returns a
 * `fail(...)` result. We assert the message contains the package
 * name + `force: true` substrings rather than a verbatim match — the
 * exact wording can shift across releases without breaking the
 * contract; what mustn't shift is the actionable hint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client, WorkflowHandle } from '@temporalio/client';

// ── Hoisted mocks. `vi.mock()` is hoisted above imports by vitest's
//    transform, so the SUT (`registerRecruitTool`) sees the mocked
//    modules at first import. ─────────────────────────────────────────
vi.mock('../../src/utils/sdk-probe', () => ({
  probeSdkInstall: vi.fn(),
}));
vi.mock('../../src/adapters/claude-code-headless/pre-flight', () => ({
  probeClaudeBinary: vi.fn(),
  probeClaudeAuth: vi.fn(),
}));

// SUT + mocked symbols (typed via `vi.mocked` for autocomplete).
import { registerRecruitTool } from '../../src/tools/recruit';
import { probeSdkInstall } from '../../src/utils/sdk-probe';
import {
  probeClaudeBinary,
  probeClaudeAuth,
} from '../../src/adapters/claude-code-headless/pre-flight';
import type { Config } from '../../src/config';
import type { AgentType } from '../../src/types';

const probeSdkMock = vi.mocked(probeSdkInstall);
const probeBinMock = vi.mocked(probeClaudeBinary);
const probeAuthMock = vi.mocked(probeClaudeAuth);

// ── Fakes (mirror `test/recruit-hosts-preflight.test.ts` pattern) ────

type CapturedHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
}>;

function makeFakeServer(): {
  server: McpServer;
  capture: { handler?: CapturedHandler };
} {
  const capture: { handler?: CapturedHandler } = {};
  const server = {
    tool: (
      _name: unknown,
      _desc: unknown,
      _schema: unknown,
      handler: CapturedHandler,
    ) => {
      capture.handler = handler;
    },
  } as unknown as McpServer;
  return { server, capture };
}

/**
 * Fake Client that satisfies `resolveSession` (returns no matches) and
 * the conductor-presence probe (`workflow.getHandle().describe()`
 * throws → handler treats as "no conductor"). Anything else throws
 * loudly so an unexpected-access regression is observable.
 */
function makeFakeClient(): Client {
  return new Proxy({} as Client, {
    get(_t, prop) {
      if (prop === 'workflow') {
        return {
          getHandle: () => ({
            describe: async () => {
              throw new Error('no conductor');
            },
            terminate: async () => {
              /* no-op */
            },
            signal: async () => {
              /* no-op */
            },
          }),
          // resolveSession iterates this — empty generator → null match.
          list: async function* () {
            /* no sessions */
          },
        };
      }
      throw new Error(
        `Unexpected Client access in recruit-preflight test: ${String(prop)}`,
      );
    },
  });
}

function makeFakeHandle(): {
  handle: WorkflowHandle;
  outboxEntries: Array<unknown>;
} {
  const outboxEntries: Array<unknown> = [];
  const handle = {
    executeUpdate: async (_update: unknown, opts: { args: unknown[] }) => {
      outboxEntries.push(opts.args[0]);
      return `outbox-${outboxEntries.length}`;
    },
  } as unknown as WorkflowHandle;
  return { handle, outboxEntries };
}

// Minimal Config shim — only the fields recruit.ts actually reads in
// pre-flight + outbox-submit paths.
const cfg = {
  ensemble: 'test-ensemble-recruit-preflight',
  taskQueue: 'agent-tempo',
  temporalNamespace: 'default',
  temporalAddress: 'localhost:7233',
  defaultAgent: 'claude' as const,
} as unknown as Config;

interface SetupResult {
  capture: { handler?: CapturedHandler };
  outboxEntries: Array<unknown>;
}

function setup(): SetupResult {
  const { server, capture } = makeFakeServer();
  const client = makeFakeClient();
  const { handle, outboxEntries } = makeFakeHandle();
  // Stub listHostsFn to a no-op — local-spawn tests never set `host`.
  registerRecruitTool(
    server,
    client,
    cfg,
    () => 'test-player',
    handle,
    'claude',
    { listHostsFn: async () => [] },
  );
  return { capture, outboxEntries };
}

// ── Per-adapter parametrization ──────────────────────────────────────
//
// Each row describes ONE pre-flight gate: how to flip its probe to
// "missing" and what substrings the error message must include.

type AdapterCase = {
  /** Display name in `describe.each` titles. */
  label: string;
  agent: AgentType;
  /** Configure mocks/env so this adapter's gate trips. */
  setupMissing: () => void;
  /** Substrings that the fail message MUST contain. */
  expectedSubstrings: string[];
};

const cases: AdapterCase[] = [
  {
    label: 'claude-api (missing ANTHROPIC_API_KEY)',
    agent: 'claude-api' as AgentType,
    setupMissing: () => {
      delete process.env.ANTHROPIC_API_KEY;
    },
    expectedSubstrings: ['claude-api', 'ANTHROPIC_API_KEY', 'force: true'],
  },
  {
    label: 'opencode (SDK not installed)',
    agent: 'opencode' as AgentType,
    setupMissing: () => {
      // probeSdkInstall returns false ONLY for the opencode SDK; the
      // copilot gate is unrelated, so its probe must still pass through
      // happily for unrelated agents in the same test run.
      probeSdkMock.mockImplementation(
        (pkg: string) => pkg !== '@opencode-ai/sdk',
      );
    },
    expectedSubstrings: ['opencode', '@opencode-ai/sdk', 'force: true'],
  },
  {
    label: 'claude-code-headless (claude binary missing)',
    agent: 'claude-code-headless' as AgentType,
    setupMissing: () => {
      probeBinMock.mockReturnValue({
        ok: false,
        error:
          'claude binary not found on PATH. Install Claude Code from https://claude.ai/code.',
      });
    },
    expectedSubstrings: ['claude-code-headless', 'force: true'],
  },
  {
    label: 'copilot (SDK not installed) — #532',
    agent: 'copilot' as AgentType,
    setupMissing: () => {
      probeSdkMock.mockImplementation(
        (pkg: string) => pkg !== '@github/copilot-sdk',
      );
    },
    expectedSubstrings: ['copilot', '@github/copilot-sdk', 'force: true'],
  },
];

// ── Tests ────────────────────────────────────────────────────────────

describe('recruit pre-flight — parametrized adapter gates (#532)', () => {
  // Snapshot ANTHROPIC_API_KEY across the suite so the claude-api row's
  // `delete` doesn't bleed into the developer's shell or other tests.
  const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    vi.resetAllMocks();
    // Defaults: every probe reports "installed / working". Each test
    // that wants a miss flips its specific probe in setupMissing().
    probeSdkMock.mockReturnValue(true);
    probeBinMock.mockReturnValue({ ok: true });
    probeAuthMock.mockReturnValue({ loggedIn: true });
    // Default: claude-api env var present so that path doesn't trip
    // unless the test explicitly deletes it.
    process.env.ANTHROPIC_API_KEY = 'sk-test-token-not-real';
  });

  afterEach(() => {
    if (savedAnthropicKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
    }
  });

  describe.each(cases)('$label', ({ agent, setupMissing, expectedSubstrings }) => {
    it('fails fast with an actionable message when the probe reports missing', async () => {
      setupMissing();
      const { capture, outboxEntries } = setup();
      const result = await capture.handler!({
        workDir: '/tmp/work',
        name: 'new-player',
        agent,
      });
      expect(result.isError).toBe(true);
      for (const sub of expectedSubstrings) {
        expect(result.content[0].text).toContain(sub);
      }
      // Most important regression assertion: the gate fired BEFORE the
      // outbox submit, so no recruit entry was queued.
      expect(outboxEntries).toHaveLength(0);
    });

    it('`force: true` bypasses the gate even when the probe reports missing', async () => {
      setupMissing();
      const { capture, outboxEntries } = setup();
      const result = await capture.handler!({
        workDir: '/tmp/work',
        name: 'new-player',
        agent,
        force: true,
      });
      // Bypass means the recruit proceeds all the way to the outbox.
      expect(result.isError).not.toBe(true);
      expect(outboxEntries).toHaveLength(1);
    });
  });
});

// ── #532-specific edge cases ─────────────────────────────────────────
//
// These don't fit cleanly into the parametrized table above — they
// assert the **copilot** gate's bounds rather than its body.

describe('copilot pre-flight specifics (#532)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    probeSdkMock.mockReturnValue(true);
    probeBinMock.mockReturnValue({ ok: true });
    probeAuthMock.mockReturnValue({ loggedIn: true });
    process.env.ANTHROPIC_API_KEY = 'sk-test-token-not-real';
  });

  it('does NOT fire for non-copilot agents, even when @github/copilot-sdk is missing', async () => {
    // Make ONLY the copilot SDK probe fail — opencode/anthropic stay green.
    probeSdkMock.mockImplementation(
      (pkg: string) => pkg !== '@github/copilot-sdk',
    );
    const { capture, outboxEntries } = setup();
    // Recruit a `claude` agent — the copilot gate must not interfere.
    const result = await capture.handler!({
      workDir: '/tmp/work',
      name: 'new-player',
      agent: 'claude',
    });
    expect(result.isError).not.toBe(true);
    // Defensive: the copilot fail wording must NOT appear in the
    // success message (regression tripwire if someone ever moves the
    // gate above the agent-equality check).
    expect(result.content[0].text).not.toContain('@github/copilot-sdk');
    expect(outboxEntries).toHaveLength(1);
  });

  it('proceeds normally when @github/copilot-sdk IS installed', async () => {
    // Default mock returns true for every package, including copilot.
    const { capture, outboxEntries } = setup();
    const result = await capture.handler!({
      workDir: '/tmp/work',
      name: 'new-player',
      agent: 'copilot',
    });
    expect(result.isError).not.toBe(true);
    expect(outboxEntries).toHaveLength(1);
    // probeSdkInstall must have been consulted with the copilot SDK
    // package specifier — proves the gate was actually exercised.
    expect(probeSdkMock).toHaveBeenCalledWith('@github/copilot-sdk');
  });

  it('skips the local pre-flight entirely when `host` is set (cross-host path)', async () => {
    // SDK is missing locally — but with `host` set, the local gate
    // must be skipped (target daemon's availableAgentTypes is the
    // gate there, not us). We can't reach the cross-host pre-flight
    // happy path in this harness without a richer hosts list, so we
    // assert the negative: the message does NOT contain the
    // local-pre-flight wording. The downstream cross-host gate
    // produces its own (different) error message.
    probeSdkMock.mockImplementation(
      (pkg: string) => pkg !== '@github/copilot-sdk',
    );
    const { capture } = setup();
    const result = await capture.handler!({
      workDir: '/tmp/work',
      name: 'new-player',
      agent: 'copilot',
      host: 'some-other-host',
    });
    // The local gate's NPM-install hint must not be present — that
    // would mean we tripped the local gate on a cross-host recruit.
    expect(result.content[0].text).not.toContain(
      'npm install @github/copilot-sdk',
    );
  });
});
