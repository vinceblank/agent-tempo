/**
 * Direct unit tests for `src/tools/fetch-state.ts` — peer-readable view
 * over player saveable state (#334 PR-1).
 *
 * The tool routes self vs peer reads through different handles:
 *   - self: reuses the cached own-session handle (no resolve)
 *   - peer: goes through `resolveSession()` so workflow-id format
 *     changes only land in one place
 *
 * Tests stub `resolveSession` via the harness fake client (its
 * `workflow.list` async-generator yields nothing → `resolveSession` returns
 * null → fail with "no session found"). For the happy peer path we provide
 * a fake list result that matches by `getMetadata`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client, WorkflowHandle } from '@temporalio/client';
import type { Config } from '../../src/config';
import { renderToMcp } from '../../src/tools/descriptor';
import { buildFetchStateTool } from '../../src/tools/fetch-state';
import { PLAYER_STATE_DEFAULT_KEY } from '../../src/utils/validation';
import { captureRegistration } from './_helpers';

const captureHandler = (registerFn: (server: McpServer) => void) =>
  captureRegistration(registerFn).call;

const TEST_CONFIG: Config = {
  temporalAddress: 'localhost:7233',
  temporalNamespace: 'default',
  taskQueue: 'agent-tempo',
  ensemble: 'pstate-test',
  defaultAgent: 'claude',
};

/** Build a fake handle whose `query` returns scripted slot data. */
function makeFakeHandle(opts: {
  slot?: { content: string; savedAt: string; savedBy: string } | null;
  queryError?: Error;
}): WorkflowHandle {
  return {
    query: vi.fn(async (def: any, args?: any) => {
      const queryName = typeof def === 'string' ? def : def?.name;
      if (opts.queryError) throw opts.queryError;
      if (queryName === 'playerState') return opts.slot ?? null;
      throw new Error(`unexpected query: ${queryName}`);
    }),
    workflowId: 'agent-session-pstate-test-target',
  } as unknown as WorkflowHandle;
}

/**
 * Build a fake client that resolves `targetPlayerId` to a handle the test
 * supplies via `peerHandle`. Set `peerHandle: null` to emulate a missing peer.
 */
function makeClient(opts: {
  targetPlayerId?: string;
  peerHandle?: WorkflowHandle | null;
}): Client {
  const target = opts.targetPlayerId ?? 'peer-1';
  const peerHandle = opts.peerHandle ?? null;

  return {
    workflow: {
      list: async function* () {
        if (peerHandle) {
          yield { workflowId: (peerHandle as any).workflowId };
        }
      },
      getHandle: (id: string) => {
        if (peerHandle && id === (peerHandle as any).workflowId) {
          // Wrap the peerHandle's query so it answers `getMetadata` like
          // the production resolveSession path expects.
          return {
            ...(peerHandle as any),
            query: async (def: any, args?: any) => {
              const name = typeof def === 'string' ? def : def?.name;
              if (name === 'getMetadata') {
                return {
                  ensemble: TEST_CONFIG.ensemble,
                  playerId: target,
                  hostname: 'h',
                  workDir: '/w',
                  isConductor: false,
                  agentType: 'claude',
                };
              }
              return (peerHandle as any).query(def, args);
            },
          };
        }
        return {
          query: async () => { throw new Error('not found'); },
        };
      },
    },
  } as unknown as Client;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('fetch_state tool (#334 PR-1)', () => {
  describe('self read', () => {
    it('returns the formatted slot for the own player by default', async () => {
      const ownHandle = makeFakeHandle({
        slot: { content: 'self-content', savedAt: '2026-05-01T03:00:00Z', savedBy: 'tempo-eng' },
      });
      const call = captureHandler((server) =>
        renderToMcp(server, [buildFetchStateTool(makeClient({}), TEST_CONFIG, ownHandle, () => 'tempo-eng')]),
      );
      const result = await call({});
      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toContain('Slot **"main"**');
      expect(text).toContain('saved by **tempo-eng**');
      expect(text).toContain('self-content');
    });

    it('returns "(no state saved …)" when the slot is empty', async () => {
      const ownHandle = makeFakeHandle({ slot: null });
      const call = captureHandler((server) =>
        renderToMcp(server, [buildFetchStateTool(makeClient({}), TEST_CONFIG, ownHandle, () => 'tempo-eng')]),
      );
      const result = await call({ key: 'bookmark' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('no state saved at slot "bookmark"');
      expect(result.content[0].text).toContain('tempo-eng');
    });

    it('default key resolves to PLAYER_STATE_DEFAULT_KEY when omitted', async () => {
      let observedKey: string | undefined;
      const ownHandle = {
        query: vi.fn(async (def: any, args: any) => {
          observedKey = args?.key;
          return null;
        }),
      } as unknown as WorkflowHandle;
      const call = captureHandler((server) =>
        renderToMcp(server, [buildFetchStateTool(makeClient({}), TEST_CONFIG, ownHandle, () => 'tempo-eng')]),
      );
      await call({});
      expect(observedKey).toBe(PLAYER_STATE_DEFAULT_KEY);
    });
  });

  describe('peer read — routes through resolveSession', () => {
    it('rejects an invalid playerId before resolving', async () => {
      const ownHandle = makeFakeHandle({});
      const call = captureHandler((server) =>
        renderToMcp(server, [buildFetchStateTool(makeClient({}), TEST_CONFIG, ownHandle, () => 'tempo-eng')]),
      );
      const result = await call({ playerId: 'has space' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid name');
    });

    it('returns "no session found" when resolveSession yields null', async () => {
      const ownHandle = makeFakeHandle({});
      // peerHandle: null → resolveSession can't match anything.
      const call = captureHandler((server) =>
        renderToMcp(server, [buildFetchStateTool(makeClient({ peerHandle: null }), TEST_CONFIG, ownHandle, () => 'tempo-eng')]),
      );
      const result = await call({ playerId: 'absent-peer' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No session found with name "absent-peer"');
    });

    it('returns the peer slot when resolveSession yields a handle', async () => {
      const ownHandle = makeFakeHandle({});
      const peerHandle = makeFakeHandle({
        slot: { content: 'peer-content', savedAt: '2026-05-01T03:00:00Z', savedBy: 'peer-1' },
      });
      const call = captureHandler((server) =>
        renderToMcp(server, [buildFetchStateTool(
          makeClient({ targetPlayerId: 'peer-1', peerHandle }),
          TEST_CONFIG,
          ownHandle,
          () => 'tempo-eng',
        )]),
      );
      const result = await call({ playerId: 'peer-1' });
      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toContain('saved by **peer-1**');
      expect(text).toContain('peer-content');
    });
  });

  describe('error mapping', () => {
    it('surfaces query errors as a tool error', async () => {
      const ownHandle = makeFakeHandle({
        queryError: new Error('Workflow not found'),
      });
      const call = captureHandler((server) =>
        renderToMcp(server, [buildFetchStateTool(makeClient({}), TEST_CONFIG, ownHandle, () => 'tempo-eng')]),
      );
      const result = await call({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to fetch state');
      expect(result.content[0].text).toContain('Workflow not found');
    });
  });
});
