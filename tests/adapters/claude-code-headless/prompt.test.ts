/**
 * Pure unit tests for the claude-code-headless prompt-build helpers
 * extracted in #536.
 *
 * `buildPromptText` and `buildClaudeArgs` were lifted out of
 * `invokeSdkWithBatch` so the per-turn driver doesn't have to be
 * spawn-mocked end-to-end to validate the system-prompt + MAESTRO_ACK
 * fix. Both helpers are pure functions over already-resolved inputs;
 * the tests below pin every invariant the issue called out (and a few
 * the tuner asked for during pre-implementation planning).
 *
 * Issue #536. The module-under-test is
 * `src/adapters/claude-code-headless/prompt.ts`; behavioral parity
 * with copilot's pre-#536 inline strings is asserted via
 * `src/adapters/sdk/system-prompt.ts` (the canonical source the two
 * adapters now share).
 */
import { describe, it, expect } from 'vitest';
import {
  buildClaudeArgs,
  buildPromptText,
  buildSdkSystemPrompt,
} from '../../../src/adapters/claude-code-headless/prompt';
import { MAESTRO_ACK } from '../../../src/adapters/sdk/system-prompt';
import type { Message } from '../../../src/types';

// ── Test fixtures ────────────────────────────────────────────────────

function msg(overrides: Partial<Message> & { from: string; text: string }): Message {
  return {
    id: 'm-' + (overrides.from + '-' + overrides.text).slice(0, 16),
    from: overrides.from,
    text: overrides.text,
    timestamp: '2026-05-09T00:00:00.000Z',
    ...overrides,
  } as Message;
}

const argsBase = {
  sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  isResume: false,
  mcpConfig: '{"mcpServers":{}}',
  permissionMode: 'acceptEdits' as const,
  dangerouslySkipPermissions: false,
  systemPrompt: 'TEST-SYSTEM-PROMPT',
  promptText: 'TEST-PROMPT-TEXT',
};

// ── buildPromptText ──────────────────────────────────────────────────

describe('buildPromptText (#536)', () => {
  it('preserves the pre-#536 attribution shape `[from X]: <text>` for non-maestro messages', () => {
    const out = buildPromptText([msg({ from: 'alice', text: 'hello' })]);
    expect(out).toBe('[from alice]: hello');
  });

  it('joins multiple messages with `\\n\\n` in input order', () => {
    const out = buildPromptText([
      msg({ from: 'alice', text: 'first' }),
      msg({ from: 'bob', text: 'second' }),
      msg({ from: 'carol', text: 'third' }),
    ]);
    expect(out).toBe('[from alice]: first\n\n[from bob]: second\n\n[from carol]: third');
  });

  it('appends MAESTRO_ACK ONLY to messages where `isMaestro === true`', () => {
    const out = buildPromptText([
      msg({ from: 'maestro', text: 'do the thing', isMaestro: true }),
      msg({ from: 'alice', text: 'background note' }),
    ]);
    expect(out).toBe(
      `[from maestro]: do the thing${MAESTRO_ACK}\n\n[from alice]: background note`,
    );
  });

  it('does NOT append MAESTRO_ACK when `isMaestro` is undefined or false', () => {
    const undefOut = buildPromptText([msg({ from: 'alice', text: 'hi' })]);
    const falseOut = buildPromptText([msg({ from: 'alice', text: 'hi', isMaestro: false })]);
    expect(undefOut).not.toContain(MAESTRO_ACK);
    expect(falseOut).not.toContain(MAESTRO_ACK);
  });

  it('applies MAESTRO_ACK per-message — not at the end of the joined output (tuner edge case)', () => {
    // Maestro on the FIRST message of a multi-message batch. The ack
    // must land directly after that message's text, NOT at the end of
    // the composite (which would address the wrong message in the
    // ensemble's reading frame).
    const out = buildPromptText([
      msg({ from: 'maestro', text: 'priority A', isMaestro: true }),
      msg({ from: 'alice', text: 'unrelated B' }),
    ]);
    expect(out).toMatch(/priority A\n\n\[IMPORTANT/);
    // The ack does NOT trail past the second (non-maestro) message.
    expect(out.endsWith(MAESTRO_ACK)).toBe(false);
    // Exactly one ack, never duplicated.
    expect(out.split(MAESTRO_ACK)).toHaveLength(2);
  });

  it('handles an empty messages array — returns empty string, no MAESTRO_ACK crash', () => {
    expect(buildPromptText([])).toBe('');
  });

  it('handles two adjacent maestro messages — both get the ack independently', () => {
    const out = buildPromptText([
      msg({ from: 'maestro', text: 'one', isMaestro: true }),
      msg({ from: 'maestro', text: 'two', isMaestro: true }),
    ]);
    // Two ack instances — one per message, not deduped.
    expect(out.split(MAESTRO_ACK)).toHaveLength(3);
  });
});

// ── buildClaudeArgs ──────────────────────────────────────────────────

describe('buildClaudeArgs (#536)', () => {
  it('emits `--append-system-prompt <systemPrompt>` — the load-bearing #536 fix', () => {
    const args = buildClaudeArgs(argsBase);
    const idx = args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('TEST-SYSTEM-PROMPT');
  });

  it('emits `--session-id <id>` on the first turn (isResume: false), NOT `--resume`', () => {
    const args = buildClaudeArgs({ ...argsBase, isResume: false });
    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe(argsBase.sessionId);
    expect(args).not.toContain('--resume');
  });

  it('emits `--resume <id>` on subsequent turns (isResume: true), NOT `--session-id`', () => {
    const args = buildClaudeArgs({ ...argsBase, isResume: true });
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe(argsBase.sessionId);
    expect(args).not.toContain('--session-id');
  });

  it('emits `--permission-mode <mode>` by default (no --dangerously-skip-permissions)', () => {
    const args = buildClaudeArgs({ ...argsBase, dangerouslySkipPermissions: false });
    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('emits `--dangerously-skip-permissions` and OMITS --permission-mode when the knob is set', () => {
    const args = buildClaudeArgs({ ...argsBase, dangerouslySkipPermissions: true });
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
  });

  it('threads --mcp-config bytes verbatim — no JSON re-parse / re-stringify', () => {
    const config = '{"mcpServers":{"claude-tempo":{"type":"stdio","command":"node"}}}';
    const args = buildClaudeArgs({ ...argsBase, mcpConfig: config });
    expect(args[args.indexOf('--mcp-config') + 1]).toBe(config);
  });

  it('promptText is the LAST argv entry (positional argument to `claude -p`)', () => {
    const args = buildClaudeArgs({ ...argsBase, promptText: 'final positional' });
    expect(args[args.length - 1]).toBe('final positional');
  });

  it('opens with the canonical flag prefix `-p --output-format stream-json --verbose`', () => {
    const args = buildClaudeArgs(argsBase);
    expect(args.slice(0, 4)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
  });

  it('emits `--strict-mcp-config` (locks down the MCP server set the model sees)', () => {
    const args = buildClaudeArgs(argsBase);
    expect(args).toContain('--strict-mcp-config');
  });
});

// ── buildSdkSystemPrompt — behavioral-parity tripwire ────────────────
//
// Tuner asked for explicit verbatim verification that the shared
// helper's output matches copilot's pre-#536 inline content. Pre-#536
// content is reconstructed inline below for the assertion (kept
// here, NOT in the source module, so refactoring the source can't
// silently relax the pin).

describe('buildSdkSystemPrompt — copilot pre-#536 parity', () => {
  it('matches the pre-#536 inline content from copilot/adapter.ts:283-297 verbatim', () => {
    const expected =
      'You are part of the "ensemble-X" ensemble coordinated via Temporal. ' +
      'You have MCP tools available — ALWAYS use these tools directly, NEVER try to run them as shell commands:\n' +
      '- set_name: Set your player name (call this FIRST if instructed)\n' +
      '- ensemble: List active sessions\n' +
      '- cue: Send a message to another player\n' +
      '- set_part: Update your status/description\n' +
      '- listen: Check for pending messages\n' +
      '- recruit: Spawn a new player session\n' +
      '- report: Report to the conductor\n' +
      '- stop: Stop a session\n\n' +
      'When you receive a message from another session, treat it like a coworker asking for help — respond promptly using your MCP tools.';
    expect(buildSdkSystemPrompt({ ensemble: 'ensemble-X' })).toBe(expected);
  });

  it('threads the ensemble parameter through the first line', () => {
    expect(buildSdkSystemPrompt({ ensemble: 'tempo-impl' })).toContain(
      'You are part of the "tempo-impl" ensemble',
    );
  });

  it('lists `cue` as one of the MCP tools the model is told to use (the load-bearing #536 directive)', () => {
    const out = buildSdkSystemPrompt({ ensemble: 'any' });
    expect(out).toContain('- cue: Send a message to another player');
    expect(out).toContain('respond promptly using your MCP tools');
  });
});

// ── MAESTRO_ACK shape ────────────────────────────────────────────────

describe('MAESTRO_ACK constant', () => {
  it('starts with two newlines so it composes cleanly when concatenated to a message line', () => {
    expect(MAESTRO_ACK.startsWith('\n\n')).toBe(true);
  });

  it('mentions `cue` (the directive that fixes the #536 symptom)', () => {
    expect(MAESTRO_ACK).toContain('cue');
  });

  it('identifies the source as a human (Maestro) — not an ensemble player', () => {
    expect(MAESTRO_ACK).toContain('human (Maestro)');
  });
});
