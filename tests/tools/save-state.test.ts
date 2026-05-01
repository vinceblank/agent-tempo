/**
 * Direct unit tests for `src/tools/save-state.ts` — the `save_state` MCP
 * tool registered alongside the other player-saveable-state surfaces in
 * #334 PR-1.
 *
 * Harness mirrors `test/tools.test.ts` (`extractHandler` over a fake
 * `McpServer`): no Temporal worker, no network, no `defineTool` round-trip
 * through the SDK. The tool's executeUpdate call is captured on a fake
 * `WorkflowHandle` so we can assert the args threaded through.
 *
 * Covers:
 *   - successful save returns the workflow's `savedAt`
 *   - default key resolution when `key` is omitted
 *   - executeUpdate is called with the right slot key + savedBy from getPlayerId
 *   - Zod-level validation rejects invalid keys before reaching executeUpdate
 *   - Zod-level validation rejects empty content
 *   - workflow-side `PlayerStateSlotsFull` / `…ContentTooLarge` propagates
 *     into the tool's error response with the structured marker preserved
 */
import { describe, it, expect } from 'vitest';
import { registerSaveStateTool } from '../../src/tools/save-state';
import {
  PLAYER_STATE_DEFAULT_KEY,
  PLAYER_STATE_CONTENT_MAX,
} from '../../src/utils/validation';
import { captureRegistration, makeFakeUpdateHandle } from './_helpers';

const makeFakeHandle = (impl?: (...args: any[]) => any) =>
  makeFakeUpdateHandle({ saved: true as const, savedAt: '2026-05-01T03:00:00.000Z' }, impl);

// ── Tests ─────────────────────────────────────────────────────────────────

describe('save_state tool (#334 PR-1)', () => {
  it('returns ok with savedAt on successful save', async () => {
    const { handle } = makeFakeHandle();
    const { call } = captureRegistration((server) =>
      registerSaveStateTool(server, handle, () => 'tempo-eng'),
    );
    const result = await call({ content: 'hello world' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Saved to slot **"main"**');
    expect(result.content[0].text).toContain('2026-05-01T03:00:00.000Z');
  });

  it('uses PLAYER_STATE_DEFAULT_KEY when key is omitted', async () => {
    const { handle, calls } = makeFakeHandle();
    const { call } = captureRegistration((server) =>
      registerSaveStateTool(server, handle, () => 'tempo-eng'),
    );
    await call({ content: 'payload' });
    expect(calls).toHaveLength(1);
    expect(calls[0].payload).toMatchObject({
      key: PLAYER_STATE_DEFAULT_KEY,
      content: 'payload',
      savedBy: 'tempo-eng',
    });
  });

  it('threads explicit key + content + savedBy through to the workflow update', async () => {
    const { handle, calls } = makeFakeHandle();
    const { call } = captureRegistration((server) =>
      registerSaveStateTool(server, handle, () => 'alice'),
    );
    await call({ key: 'bookmark', content: 'snapshot' });
    expect(calls[0].payload).toEqual({
      key: 'bookmark',
      content: 'snapshot',
      savedBy: 'alice',
    });
  });

  it('Zod schema rejects keys that violate PLAYER_STATE_KEY_REGEX', () => {
    // Validate via the captured Zod schema directly — this is the same
    // shape the MCP SDK applies before invoking the handler.
    const { schemas } = captureRegistration((server) =>
      registerSaveStateTool(server, makeFakeHandle().handle, () => 'tempo-eng'),
    );
    expect(schemas.key.safeParse('has space').success).toBe(false);
    expect(schemas.key.safeParse('bad/slash').success).toBe(false);
    expect(schemas.key.safeParse('').success).toBe(false);
    expect(schemas.key.safeParse('valid-1_key').success).toBe(true);
  });

  it('Zod schema rejects content larger than PLAYER_STATE_CONTENT_MAX', () => {
    const { schemas } = captureRegistration((server) =>
      registerSaveStateTool(server, makeFakeHandle().handle, () => 'tempo-eng'),
    );
    const oversized = 'A'.repeat(PLAYER_STATE_CONTENT_MAX + 1);
    expect(schemas.content.safeParse(oversized).success).toBe(false);
    const atLimit = 'A'.repeat(PLAYER_STATE_CONTENT_MAX);
    expect(schemas.content.safeParse(atLimit).success).toBe(true);
    expect(schemas.content.safeParse('').success).toBe(false); // min(1)
  });

  it('surfaces PlayerStateSlotsFull as an isError result preserving the structured marker', async () => {
    const { handle } = makeFakeHandle(() => {
      throw new Error('PlayerStateSlotsFull: playerState slots full (4). Existing slots: a, b, c, main');
    });
    const { call } = captureRegistration((server) =>
      registerSaveStateTool(server, handle, () => 'tempo-eng'),
    );
    const result = await call({ key: 'fifth', content: 'overflow' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/PlayerStateSlotsFull/);
    // The existing-keys hint must reach the LLM verbatim so it can pick which to clear.
    expect(result.content[0].text).toContain('Existing slots: a, b, c, main');
  });

  it('surfaces PlayerStateContentTooLarge similarly when the workflow rejects', async () => {
    const { handle } = makeFakeHandle(() => {
      throw new Error('PlayerStateContentTooLarge: playerState content exceeds 32768 bytes');
    });
    const { call } = captureRegistration((server) =>
      registerSaveStateTool(server, handle, () => 'tempo-eng'),
    );
    const result = await call({ content: 'something' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/PlayerStateContentTooLarge/);
  });
});
