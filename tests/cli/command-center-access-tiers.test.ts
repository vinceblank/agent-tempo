/**
 * #791 — command-center access-tier SINGLE SOURCE OF TRUTH drift guard.
 *
 * The three access tiers are described in exactly one place
 * (`COMMAND_CENTER_ACCESS_TIERS` in src/constants.ts) and surfaced in two:
 *   1. the `command-center` launch banner (src/cli/command-center-command.ts,
 *      via `commandCenterAccessTierLines`), and
 *   2. `docs/cli.md`.
 *
 * This test fails if the banner or the docs ever drift from the constant —
 * the architect's "keep the tier descriptions IDENTICAL across the warning
 * text and the docs" requirement, enforced mechanically.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  COMMAND_CENTER_ACCESS_TIERS,
  commandCenterAccessTierLines,
} from '../../src/constants';

const CLI_DOC = path.resolve(__dirname, '..', '..', 'docs', 'cli.md');

describe('command-center access tiers — single source of truth (#791)', () => {
  it('defines exactly the three tiers, in order: No auth, /login, API key', () => {
    expect(COMMAND_CENTER_ACCESS_TIERS.map((t) => t.label)).toEqual([
      'No auth',
      '/login',
      'API key',
    ]);
  });

  it('the launch banner renders every tier label + description verbatim', () => {
    const lines = commandCenterAccessTierLines();
    expect(lines).toHaveLength(COMMAND_CENTER_ACCESS_TIERS.length);
    // Lines are index-aligned with the tiers (one per tier, in order). Match by
    // index — NOT by label substring: "API key" is a substring of the /login
    // tier's "zero API key", so a find-by-label would mis-bind.
    COMMAND_CENTER_ACCESS_TIERS.forEach((tier, i) => {
      // Both halves present, unmodified, on the same line.
      expect(lines[i]).toContain(tier.label);
      expect(lines[i]).toContain(tier.description);
    });
  });

  it('docs/cli.md carries each tier label + description VERBATIM (no drift)', () => {
    const doc = fs.readFileSync(CLI_DOC, 'utf8');
    for (const tier of COMMAND_CENTER_ACCESS_TIERS) {
      expect(
        doc.includes(tier.label),
        `docs/cli.md must contain the "${tier.label}" tier label`,
      ).toBe(true);
      expect(
        doc.includes(tier.description),
        `docs/cli.md must contain the "${tier.label}" description verbatim`,
      ).toBe(true);
    }
  });

  it('the /login tier advertises the zero-API-key Claude-subscription planner path', () => {
    const login = COMMAND_CENTER_ACCESS_TIERS.find((t) => t.label === '/login');
    expect(login, 'a /login tier must exist').toBeDefined();
    expect(login!.description).toMatch(/zero API key/i);
    expect(login!.description).toMatch(/subscription/i);
    expect(login!.description).toContain('/login');
  });

  it('the no-auth tier makes clear the board + controls need no token or login', () => {
    const noAuth = COMMAND_CENTER_ACCESS_TIERS[0];
    expect(noAuth.label).toBe('No auth');
    expect(noAuth.description).toMatch(/no token or login required/i);
    expect(noAuth.description).toMatch(/operator controls/i);
  });
});
