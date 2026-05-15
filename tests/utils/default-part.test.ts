/**
 * Unit tests for `defaultPart` (#450).
 *
 * Covers the player-type-aware default that replaces the leaking
 * `'Conductor session'` literal and the role-agnostic
 * `'Session in <basename>'` fallback at the four session-workflow
 * seed sites (`src/cli/commands.ts`, `src/activities/outbox.ts`,
 * `src/server.ts`).
 */
import { describe, it, expect } from 'vitest';
import { defaultPart, HEADLESS_ADAPTERS } from '../../src/utils/default-part';
import { AGENT_TYPES } from '../../src/types';

describe('defaultPart', () => {
  describe('player-type-aware defaults', () => {
    it('strips `tempo-` prefix and title-cases shipped types', () => {
      expect(defaultPart({ playerType: 'tempo-conductor' })).toBe('Conductor session');
      expect(defaultPart({ playerType: 'tempo-soloist' })).toBe('Soloist session');
      expect(defaultPart({ playerType: 'tempo-composer' })).toBe('Composer session');
      expect(defaultPart({ playerType: 'tempo-tuner' })).toBe('Tuner session');
      expect(defaultPart({ playerType: 'tempo-critic' })).toBe('Critic session');
      expect(defaultPart({ playerType: 'tempo-roadie' })).toBe('Roadie session');
      expect(defaultPart({ playerType: 'tempo-improv' })).toBe('Improv session');
      expect(defaultPart({ playerType: 'tempo-liner' })).toBe('Liner session');
    });

    it('strips `my-tempo-` prefix for per-user override types', () => {
      expect(defaultPart({ playerType: 'my-tempo-engineer' })).toBe('Engineer session');
      expect(defaultPart({ playerType: 'my-tempo-architect' })).toBe('Architect session');
      expect(defaultPart({ playerType: 'my-tempo-researcher' })).toBe('Researcher session');
      expect(defaultPart({ playerType: 'my-tempo-docs' })).toBe('Docs session');
    });

    it('strips `la-tempo-` prefix for project agents', () => {
      expect(defaultPart({ playerType: 'la-tempo-advisor' })).toBe('Advisor session');
    });

    it('uses canonical capitalisation for known abbreviations', () => {
      // Naive title-casing would produce 'Qa', 'Po', 'Devops' — wrong.
      expect(defaultPart({ playerType: 'my-tempo-qa' })).toBe('QA session');
      expect(defaultPart({ playerType: 'my-tempo-po' })).toBe('PO session');
      expect(defaultPart({ playerType: 'my-tempo-devops' })).toBe('DevOps session');
      // Plain `tempo-qa` (no `my-`/`la-` prefix) follows the same rule.
      expect(defaultPart({ playerType: 'tempo-qa' })).toBe('QA session');
    });

    it('abbreviation lookup is case-insensitive on the suffix', () => {
      expect(defaultPart({ playerType: 'my-tempo-QA' })).toBe('QA session');
      expect(defaultPart({ playerType: 'tempo-DevOps' })).toBe('DevOps session');
    });

    it('falls through to title-case for unknown / custom types', () => {
      // Non-tempo prefix preserved, first char capitalised.
      expect(defaultPart({ playerType: 'acme-reviewer' })).toBe('Acme-reviewer session');
      expect(defaultPart({ playerType: 'helper' })).toBe('Helper session');
    });

    it('is whitespace-tolerant on the input', () => {
      expect(defaultPart({ playerType: '  tempo-engineer  ' })).toBe('Engineer session');
    });

    it('player type wins over isConductor when both are set', () => {
      // Typed conductor reads as `'Conductor session'` via prefix-strip,
      // not via the conductor fallback — so the result is the same, but
      // the path matters for non-`tempo-conductor` typed conductors.
      expect(defaultPart({ playerType: 'my-tempo-engineer', isConductor: true })).toBe(
        'Engineer session',
      );
    });

    it('player type wins over workDir', () => {
      expect(
        defaultPart({ playerType: 'tempo-soloist', workDir: '/some/repo' }),
      ).toBe('Soloist session');
    });
  });

  describe('untyped fallbacks', () => {
    it('returns the conductor literal for untyped conductors', () => {
      expect(defaultPart({ isConductor: true })).toBe('Conductor session');
      // workDir doesn't override the conductor fallback.
      expect(defaultPart({ isConductor: true, workDir: '/some/repo' })).toBe(
        'Conductor session',
      );
    });

    it('returns `Session in <basename>` for untyped non-conductors with a workDir', () => {
      expect(defaultPart({ workDir: '/repos/agent-tempo' })).toBe(
        'Session in agent-tempo',
      );
      expect(defaultPart({ isConductor: false, workDir: '/some/repo' })).toBe(
        'Session in repo',
      );
    });

    it('returns `New session` when nothing identifies the role', () => {
      expect(defaultPart({})).toBe('New session');
      expect(defaultPart({ playerType: '' })).toBe('New session');
      // Empty/whitespace-only workDir doesn't qualify.
      expect(defaultPart({ workDir: '   ' })).toBe('New session');
    });

    it('treats a player type that is just the prefix as untyped', () => {
      // `'tempo-'` strips to `''` — should fall through to the
      // isConductor / workDir cascade, not produce `' session'`.
      expect(defaultPart({ playerType: 'tempo-', isConductor: true })).toBe(
        'Conductor session',
      );
      expect(defaultPart({ playerType: 'my-tempo-', workDir: '/some/repo' })).toBe(
        'Session in repo',
      );
    });
  });

  describe('headless-adapter defaults (#537)', () => {
    it('returns headless default for claude-code-headless adapter', () => {
      expect(defaultPart({ adapterType: 'claude-code-headless', workDir: '/work' })).toBe(
        'Headless claude-code-headless session',
      );
    });

    it('returns headless default for copilot adapter', () => {
      expect(defaultPart({ adapterType: 'copilot', workDir: '/work' })).toBe(
        'Headless copilot session',
      );
    });

    it('returns headless default for opencode adapter', () => {
      expect(defaultPart({ adapterType: 'opencode' })).toBe(
        'Headless opencode session',
      );
    });

    it('returns headless default for claude-api adapter', () => {
      expect(defaultPart({ adapterType: 'claude-api' })).toBe(
        'Headless claude-api session',
      );
    });

    it('returns headless default for mock adapter', () => {
      expect(defaultPart({ adapterType: 'mock' })).toBe(
        'Headless mock session',
      );
    });

    it('interactive claude adapter falls through to workDir default', () => {
      expect(defaultPart({ adapterType: 'claude', workDir: '/repos/my-project' })).toBe(
        'Session in my-project',
      );
    });

    it('interactive claude adapter with no workDir falls through to New session', () => {
      expect(defaultPart({ adapterType: 'claude' })).toBe('New session');
    });

    it('playerType takes priority over headless adapter default', () => {
      expect(
        defaultPart({ playerType: 'tempo-soloist', adapterType: 'claude-code-headless' }),
      ).toBe('Soloist session');
    });

    it('isConductor takes priority over headless adapter default', () => {
      expect(
        defaultPart({ isConductor: true, adapterType: 'copilot' }),
      ).toBe('Conductor session');
    });

    it('is whitespace-tolerant on adapterType', () => {
      expect(defaultPart({ adapterType: '  opencode  ' })).toBe(
        'Headless opencode session',
      );
    });
  });

  describe('HEADLESS_ADAPTERS drift detector (#537)', () => {
    it('every non-claude member of AGENT_TYPES is in HEADLESS_ADAPTERS', () => {
      // If a future adapter is added to AGENT_TYPES but not categorised
      // here, this test fails loudly. If the new adapter is intentionally
      // interactive (like 'claude'), add it to the opt-out list below.
      const INTERACTIVE_OPT_OUT = new Set(['claude']);
      for (const t of AGENT_TYPES) {
        if (INTERACTIVE_OPT_OUT.has(t)) continue;
        expect(
          HEADLESS_ADAPTERS.has(t),
          `AGENT_TYPES member '${t}' is not in HEADLESS_ADAPTERS — ` +
          `add it there or to INTERACTIVE_OPT_OUT if intentionally interactive`,
        ).toBe(true);
      }
    });

    it('HEADLESS_ADAPTERS contains only known AGENT_TYPES members', () => {
      for (const h of HEADLESS_ADAPTERS) {
        expect(
          (AGENT_TYPES as readonly string[]).includes(h),
          `HEADLESS_ADAPTERS member '${h}' is not in AGENT_TYPES`,
        ).toBe(true);
      }
    });
  });
});
