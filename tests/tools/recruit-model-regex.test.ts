/**
 * #773 — the recruit `model` id zod regex must accept MIXED-CASE ids.
 *
 * Custom-provider model ids (LM Studio's models.json, etc.) are user-defined and
 * frequently mixed-case (e.g. `lmstudio/Qwen/Qwen3-27B`). The original regex was
 * lowercase-only (`^[a-z0-9][a-z0-9-/.:_]*$`), rejecting them at the schema layer
 * before any adapter ran. The fix widens to allow `A-Z` (anchor + body) while
 * keeping the leading-alphanumeric anchor and the safe char set `[A-Za-z0-9-/.:_]`
 * (no shell metacharacters — the value is env-injected opaquely by spawn helpers).
 *
 * Tested via the descriptor's raw zod shape (`buildRecruitTool(...).params.model`)
 * — building the descriptor only reads `ownAgentType`, so minimal shims suffice
 * (the client/config/handle are never touched for schema access).
 */
import { describe, it, expect } from 'vitest';
import type { Client, WorkflowHandle } from '@temporalio/client';
import type { ZodTypeAny } from 'zod';
import { buildRecruitTool } from '../../src/tools/recruit';
import type { Config } from '../../src/config';

function modelSchema(): ZodTypeAny {
  const descriptor = buildRecruitTool(
    {} as unknown as Client,
    {
      ensemble: 'x',
      taskQueue: 'agent-tempo',
      temporalNamespace: 'default',
      temporalAddress: 'localhost:7233',
    } as unknown as Config,
    () => 'p',
    {} as unknown as WorkflowHandle,
    'claude',
    undefined,
    { listHostsFn: async () => [] },
  );
  return descriptor.params.model as ZodTypeAny;
}

describe('recruit model id regex (#773 — mixed-case)', () => {
  const schema = modelSchema();
  const ok = (v: string) => schema.safeParse(v).success;

  it('accepts mixed-case custom-provider ids (the #773 fix — LM Studio etc.)', () => {
    expect(ok('lmstudio/Qwen/Qwen3-27B')).toBe(true);
    expect(ok('LMStudio/Qwen3-27B')).toBe(true); // mixed-case provider too
    expect(ok('anthropic/Claude-Opus-4-5')).toBe(true);
    expect(ok('Qwen3-27B')).toBe(true); // leading uppercase
  });

  it('still accepts the existing lowercase ids (no regression)', () => {
    expect(ok('claude-opus-4-7')).toBe(true);
    expect(ok('anthropic/claude-opus-4-7')).toBe(true);
    expect(ok('openai/gpt-4o')).toBe(true);
    expect(ok('ollama/llama3')).toBe(true);
    expect(ok('github-copilot/gpt-4o')).toBe(true);
    expect(ok('lmstudio/qwen/qwen3.6-27b')).toBe(true);
  });

  it('accepts the safe char set (- / . : _) and a leading digit', () => {
    expect(ok('3.5-sonnet')).toBe(true);
    expect(ok('provider/model:tag_v2.1')).toBe(true);
  });

  it('still REJECTS unsafe / malformed ids (spaces, shell metachars, bad anchor, empty)', () => {
    expect(ok('has spaces')).toBe(false);
    expect(ok('model;rm -rf /')).toBe(false);
    expect(ok('a&b')).toBe(false);
    expect(ok('$(whoami)')).toBe(false);
    expect(ok('model|pipe')).toBe(false);
    expect(ok('-leading-dash')).toBe(false); // must start alphanumeric
    expect(ok('/leading-slash')).toBe(false);
    expect(ok('')).toBe(false);
    expect(ok('model\nwith-newline')).toBe(false);
  });

  it('the optional param accepts undefined (model omitted)', () => {
    expect(schema.safeParse(undefined).success).toBe(true);
  });
});
