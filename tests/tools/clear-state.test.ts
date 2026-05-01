/**
 * Direct unit tests for `src/tools/clear-state.ts` (#334 PR-1).
 *
 * Owner-only by structure — no `playerId` arg. The tool always invokes
 * `clearPlayerStateUpdate` against the calling player's own handle. Tests
 * cover the two success messages (`cleared` vs `was already empty`),
 * default-key behaviour, Zod-level rejection of bad keys, and propagation
 * of workflow-side errors into an isError response.
 */
import { describe, it, expect } from 'vitest';
import { registerClearStateTool } from '../../src/tools/clear-state';
import { PLAYER_STATE_DEFAULT_KEY } from '../../src/utils/validation';
import { captureRegistration, makeFakeUpdateHandle } from './_helpers';

const makeFakeHandle = (impl?: (...args: any[]) => any) =>
  makeFakeUpdateHandle({ cleared: true }, impl);

describe('clear_state tool (#334 PR-1)', () => {
  it('reports "Cleared slot" when the workflow returns cleared:true', async () => {
    const { handle } = makeFakeHandle(() => ({ cleared: true }));
    const { call } = captureRegistration((server) =>
      registerClearStateTool(server, handle),
    );
    const result = await call({ key: 'bookmark' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('Cleared slot **"bookmark"**.');
  });

  it('reports "was already empty" when the workflow returns cleared:false', async () => {
    const { handle } = makeFakeHandle(() => ({ cleared: false }));
    const { call } = captureRegistration((server) =>
      registerClearStateTool(server, handle),
    );
    const result = await call({ key: 'main' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('Slot **"main"** was already empty.');
  });

  it('uses PLAYER_STATE_DEFAULT_KEY when key is omitted', async () => {
    const { handle, calls } = makeFakeHandle();
    const { call } = captureRegistration((server) =>
      registerClearStateTool(server, handle),
    );
    await call({});
    expect(calls).toHaveLength(1);
    expect(calls[0].payload).toEqual({ key: PLAYER_STATE_DEFAULT_KEY });
  });

  it('Zod schema rejects keys that violate PLAYER_STATE_KEY_REGEX', () => {
    const { schemas } = captureRegistration((server) =>
      registerClearStateTool(server, makeFakeHandle().handle),
    );
    expect(schemas.key.safeParse('has space').success).toBe(false);
    expect(schemas.key.safeParse('bad/slash').success).toBe(false);
    expect(schemas.key.safeParse('').success).toBe(false);
    expect(schemas.key.safeParse('valid_-1').success).toBe(true);
  });

  it('surfaces workflow rejections as an isError result', async () => {
    const { handle } = makeFakeHandle(() => {
      throw new Error('PlayerStateInvalidKey: "bad" is not allowed');
    });
    const { call } = captureRegistration((server) =>
      registerClearStateTool(server, handle),
    );
    const result = await call({ key: 'main' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to clear state');
    expect(result.content[0].text).toMatch(/PlayerStateInvalidKey/);
  });
});
