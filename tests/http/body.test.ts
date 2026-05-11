/**
 * Drift detector for the HTTP recruit allowlists in `src/http/body.ts`.
 *
 * Background — #541: `ALLOWED_AGENTS_PROD` / `ALLOWED_AGENTS_DEV` were
 * hand-maintained string-literal arrays. When `claude-api` (#131),
 * `opencode` (#449), and `claude-code-headless` (#520) landed, nobody
 * remembered to add them to the HTTP allowlist, so the dashboard /
 * direct-POST recruit path silently rejected them with a 400 even
 * though `AGENT_TYPES` (the SSOT) listed them.
 *
 * The fix derives both allowlists from `AGENT_TYPES`. These tests
 * enforce that derivation contractually so a future hand-edit that
 * reintroduces the drift breaks CI.
 *
 * What we assert:
 *  - Every entry in `AGENT_TYPES` appears in the appropriate allowlist.
 *  - `ALLOWED_AGENTS_DEV` == `AGENT_TYPES` (modulo ordering — equality
 *    by Set membership).
 *  - `ALLOWED_AGENTS_PROD` == `AGENT_TYPES` minus the dev-only entries
 *    (currently just `'mock'`).
 *  - `allowedAgentsForCurrentMode()` picks the right list based on
 *    `isDevMode()`.
 *  - `isAllowedAgent()` correctly narrows to the `AgentType` union.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_AGENTS_DEV,
  ALLOWED_AGENTS_PROD,
  allowedAgentsForCurrentMode,
  isAllowedAgent,
} from '../../src/http/body';
import { AGENT_TYPES, type AgentType } from '../../src/types';

describe('src/http/body.ts — recruit allowlists (#541)', () => {
  describe('ALLOWED_AGENTS_DEV', () => {
    it('covers every entry in AGENT_TYPES (no SSOT drift)', () => {
      for (const agent of AGENT_TYPES) {
        expect(ALLOWED_AGENTS_DEV).toContain(agent);
      }
    });

    it('contains no entries that are absent from AGENT_TYPES', () => {
      const ssot = new Set<string>(AGENT_TYPES);
      for (const a of ALLOWED_AGENTS_DEV) {
        expect(ssot.has(a)).toBe(true);
      }
    });

    it('matches AGENT_TYPES by set equality (length parity catches accidental subsets)', () => {
      expect(ALLOWED_AGENTS_DEV.length).toBe(AGENT_TYPES.length);
    });
  });

  describe('ALLOWED_AGENTS_PROD', () => {
    it('excludes the dev-only `mock` adapter (ADR 0014 §7)', () => {
      expect(ALLOWED_AGENTS_PROD).not.toContain('mock');
    });

    it('contains every non-dev-only AGENT_TYPES entry', () => {
      // Today the only dev-only entry is `'mock'`. If that grows we want
      // *this* test to break first (so the maintainer reads the comment
      // and updates DEV_ONLY_AGENTS in body.ts deliberately) rather than
      // a surprise rejection in prod.
      const expectedProd = AGENT_TYPES.filter((a) => a !== 'mock');
      for (const agent of expectedProd) {
        expect(ALLOWED_AGENTS_PROD).toContain(agent);
      }
      expect(ALLOWED_AGENTS_PROD.length).toBe(expectedProd.length);
    });

    it('accepts the three headless adapters added after the original allowlist was written (#131, #449, #520)', () => {
      // Belt-and-braces — even if AGENT_TYPES shrinks (it won't, those
      // are documented stable wire identifiers), the three adapters
      // that #541 specifically named must be in the prod allowlist.
      expect(ALLOWED_AGENTS_PROD).toContain('claude-api');
      expect(ALLOWED_AGENTS_PROD).toContain('opencode');
      expect(ALLOWED_AGENTS_PROD).toContain('claude-code-headless');
    });
  });

  describe('allowedAgentsForCurrentMode()', () => {
    let prev: string | undefined;
    beforeEach(() => { prev = process.env.CLAUDE_TEMPO_DEV_MODE; });
    afterEach(() => {
      if (prev === undefined) delete process.env.CLAUDE_TEMPO_DEV_MODE;
      else process.env.CLAUDE_TEMPO_DEV_MODE = prev;
    });

    it('returns ALLOWED_AGENTS_PROD when CLAUDE_TEMPO_DEV_MODE is unset', () => {
      delete process.env.CLAUDE_TEMPO_DEV_MODE;
      expect(allowedAgentsForCurrentMode()).toBe(ALLOWED_AGENTS_PROD);
    });

    it('returns ALLOWED_AGENTS_DEV when CLAUDE_TEMPO_DEV_MODE=1', () => {
      process.env.CLAUDE_TEMPO_DEV_MODE = '1';
      expect(allowedAgentsForCurrentMode()).toBe(ALLOWED_AGENTS_DEV);
    });
  });

  describe('isAllowedAgent()', () => {
    it('accepts every AGENT_TYPES entry against ALLOWED_AGENTS_DEV', () => {
      for (const agent of AGENT_TYPES as readonly string[]) {
        expect(isAllowedAgent(agent, ALLOWED_AGENTS_DEV)).toBe(true);
      }
    });

    it('rejects unknown strings', () => {
      expect(isAllowedAgent('rogue', ALLOWED_AGENTS_DEV)).toBe(false);
      expect(isAllowedAgent('', ALLOWED_AGENTS_PROD)).toBe(false);
      expect(isAllowedAgent('CLAUDE', ALLOWED_AGENTS_PROD)).toBe(false); // case-sensitive
    });

    it('rejects `mock` against the prod allowlist (dev-only gate)', () => {
      expect(isAllowedAgent('mock', ALLOWED_AGENTS_PROD)).toBe(false);
    });

    // Compile-time guarantee — the type guard narrows to AgentType. If
    // this ever stops compiling, the allowlist's typing has regressed.
    it('narrows string -> AgentType on the truthy branch', () => {
      const s: string = 'claude';
      if (isAllowedAgent(s, ALLOWED_AGENTS_PROD)) {
        const _typed: AgentType = s; // type-level assertion
        void _typed;
      }
    });
  });
});
