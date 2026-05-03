/**
 * Unit tests for claude-code-headless adapter registration and AgentType
 * extension. PR-1 — verifies the descriptor lands in the registry, the
 * agent type is in the canonical tuple, and `resolveFromAgentType` maps
 * `'claude-code-headless'` → the adapter id.
 */
import { describe, it, expect } from 'vitest';
import { registry } from '../../../src/adapters';
import { AGENT_TYPES } from '../../../src/types';
import {
  ClaudeCodeHeadlessAttachment,
  claudeCodeHeadlessDescriptor,
} from '../../../src/adapters/claude-code-headless';

describe('claude-code-headless adapter registration', () => {
  it('registers the descriptor with the singleton registry at module load', () => {
    expect(registry.has('claude-code-headless')).toBe(true);
    const desc = registry.get('claude-code-headless');
    expect(desc).toBe(claudeCodeHeadlessDescriptor);
  });

  it('descriptor declares SDK class with 30s heartbeat (per design §4)', () => {
    expect(claudeCodeHeadlessDescriptor.adapterClass).toBe('sdk');
    expect(claudeCodeHeadlessDescriptor.blocksOnLLMTurn).toBe(true);
    expect(claudeCodeHeadlessDescriptor.heartbeatMs).toBe(30_000);
  });

  it('AGENT_TYPES tuple includes "claude-code-headless"', () => {
    expect(AGENT_TYPES).toContain('claude-code-headless');
  });

  it('resolveFromAgentType maps "claude-code-headless" to its adapter id', () => {
    expect(registry.resolveFromAgentType('claude-code-headless')).toBe('claude-code-headless');
  });

  it('preserves existing agent-type resolution (no regression)', () => {
    expect(registry.resolveFromAgentType('claude')).toBe('claude-code');
    expect(registry.resolveFromAgentType('copilot')).toBe('copilot');
    expect(registry.resolveFromAgentType('claude-api')).toBe('claude-api');
    expect(registry.resolveFromAgentType('opencode')).toBe('opencode');
    expect(registry.resolveFromAgentType(undefined)).toBe('claude-code');
  });
});

describe('ClaudeCodeHeadlessAttachment construction', () => {
  it('exposes the descriptor on the instance', () => {
    const attachment = new ClaudeCodeHeadlessAttachment();
    expect(attachment.descriptor).toBe(claudeCodeHeadlessDescriptor);
  });

  it('accepts permissionMode option', () => {
    // Construction must succeed; the public surface doesn't expose the
    // resolved value (it's protected on the class), but an exception here
    // would indicate the option type is wrong.
    expect(() => new ClaudeCodeHeadlessAttachment({ permissionMode: 'acceptEdits' })).not.toThrow();
    expect(() => new ClaudeCodeHeadlessAttachment({ permissionMode: 'bypassPermissions' })).not.toThrow();
  });

  it('accepts dangerouslySkipPermissions option', () => {
    expect(() => new ClaudeCodeHeadlessAttachment({ dangerouslySkipPermissions: true })).not.toThrow();
  });

  it('PR-3: invokeSdkWithBatch throws when sessionId is uninitialized (run() must precede)', async () => {
    // PR-3 replaces the PR-2 stub with the real per-turn `claude -p`
    // implementation. Calling it before run() initialized sessionId
    // surfaces a programmer-error rather than silently spawning with a
    // bogus session UUID. Narrowest test surface that doesn't need a
    // full Temporal harness.
    const attachment = new ClaudeCodeHeadlessAttachment() as unknown as {
      invokeSdkWithBatch: (
        messages: unknown[],
        prompt: string,
        timeoutMs: number,
      ) => Promise<unknown>;
    };
    await expect(attachment.invokeSdkWithBatch([], '', 1000)).rejects.toThrow(/sessionId/);
  });
});
