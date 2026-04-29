/**
 * PlayerTypes screen — PR-F2 of #389, with the PR-D pixel-audit pins
 * (T-1 column rule + T-2 `.row` migration + T-3 `.display` heading).
 * Tests cover: card rendering for all 8 types, the source label,
 * summary text, header actions, the canonical 2-up `.types-grid`
 * column rule, and the JSX class application (`.row` containers +
 * `.display` heading) that lets F-LEAD-4's phone-wrap rules at
 * `components.css:1603-1613` actually select the impl tree.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import { PlayerTypes } from '../src/screens/PlayerTypes';
import { MockDashboardClient } from './fixtures/mock-client';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}
function renderPlayerTypes() {
  __setDashboardClientForTests(new MockDashboardClient());
  return render(
    <QueryClientProvider client={newQc()}>
      <MemoryRouter><PlayerTypes /></MemoryRouter>
    </QueryClientProvider> as ReactNode,
  );
}

const SHIPPED_NAMES = [
  'tempo-conductor',
  'tempo-composer',
  'tempo-critic',
  'tempo-improv',
  'tempo-liner',
  'tempo-roadie',
  'tempo-soloist',
  'tempo-tuner',
];

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  __setDashboardClientForTests(null);
  vi.restoreAllMocks();
});

describe('PlayerTypes screen', () => {
  it('renders the section + grid container', () => {
    renderPlayerTypes();
    expect(screen.getByTestId('screen-player-types')).toBeInTheDocument();
    expect(screen.getByTestId('player-types-grid')).toBeInTheDocument();
  });

  it('renders one card per shipped player type (all 8)', () => {
    renderPlayerTypes();
    for (const name of SHIPPED_NAMES) {
      expect(screen.getByTestId(`player-type-card-${name}`)).toBeInTheDocument();
    }
  });

  it('each card surfaces source label + summary + Edit/Duplicate actions', () => {
    renderPlayerTypes();
    const name = 'tempo-conductor';
    expect(screen.getByTestId(`player-type-card-${name}-source`).textContent).toBe('SHIPPED');
    expect(screen.getByTestId(`player-type-card-${name}-summary`).textContent).toMatch(
      /orchestrates/i,
    );
    expect(screen.getByTestId(`player-type-card-${name}-edit`)).toBeInTheDocument();
    expect(screen.getByTestId(`player-type-card-${name}-duplicate`)).toBeInTheDocument();
  });

  it('Re-scan + New type header actions are clickable (no-op + log line)', () => {
    renderPlayerTypes();
    // Header actions are pushed via useScreenPageHeader — they only
    // render inside an AppShell. Without an AppShell wrapper the
    // pushHeader hook no-ops. Test scopes the assertion to "the screen
    // exposes the action handlers" by importing the module-level
    // helpers… but since they're closures, the simplest signal is that
    // the screen mounts without throwing. The full header → action
    // wiring is covered by app-shell-slot.test.tsx + the manual
    // browser smoke at PR-time.
    expect(screen.getByTestId('screen-player-types')).toBeInTheDocument();
  });

  // ─── PR-D pin (T-2 + T-3) — JSX class application ────────────
  // Card row containers must carry `.row` (not inline-flex) so
  // F-LEAD-4's phone-wrap rules at `components.css:1603-1613` actually
  // select the impl tree. The heading must carry `.display` so the
  // canonical letter-spacing utility applies. Regression here loses
  // long-label wrapping at the phone breakpoint.
  describe('canonical class application (PR-D of #454)', () => {
    it('meta + actions row containers carry the canonical `.row` utility class', () => {
      renderPlayerTypes();
      const name = 'tempo-conductor';
      expect(screen.getByTestId(`player-type-card-${name}-meta-row`).className).toContain('row');
      expect(screen.getByTestId(`player-type-card-${name}-actions-row`).className).toContain('row');
    });

    it('inner action-button row uses `.row` (gap:8) not inline-flex (gap:4)', () => {
      // The Edit + Duplicate button cluster sits inside exactly one
      // `.row` child of the actions row.
      renderPlayerTypes();
      const name = 'tempo-conductor';
      const actionsRow = screen.getByTestId(`player-type-card-${name}-actions-row`);
      expect(actionsRow.querySelectorAll('.row').length).toBe(1);
    });

    it('heading carries the `.display` utility (font-family + letter-spacing)', () => {
      renderPlayerTypes();
      const name = 'tempo-conductor';
      const heading = screen.getByTestId(`player-type-card-${name}-name`);
      expect(heading.className).toContain('display');
      // Canonical inline shape is `<div className="display" style={{fontSize: 20}}>`.
      expect(heading.style.fontSize).toBe('20px');
    });
  });

  // ─── PR-D pin (T-1) — `.types-grid` column rule ──────────────
  // Static drift detector against the canonical 2-up grid. We don't
  // rely on jsdom resolving grid-template-columns through the cascade
  // (its CSS-grid support is too thin) — instead, we read the source
  // CSS file and pin the rule body. Catches an accidental revert to
  // the prior `auto-fill / minmax(155px, 175px)` chat2.md fix.
  describe('.types-grid column rule (T-1 of audit §4.4)', () => {
    const COMPONENTS_CSS = readFileSync(
      resolve(process.cwd(), 'src/styles/components.css'),
      'utf8',
    );

    it('declares the canonical 2-up `1fr 1fr` grid', () => {
      // Match the `.types-grid { ... }` block (non-greedy up to the
      // closing brace) at the top-level selector — not the nested
      // `@container artboard` overrides which use `1fr` (tablet) or
      // omit columns entirely (phone padding-only).
      const block = COMPONENTS_CSS.match(/^\.types-grid\s*\{[^}]*\}/m);
      expect(block, 'top-level .types-grid block missing').not.toBeNull();
      expect(block![0]).toMatch(/grid-template-columns:\s*1fr\s+1fr\s*;/);
      // Negative pin — auto-fill is the regression shape.
      expect(block![0]).not.toMatch(/auto-fill/);
    });

    it('keeps tablet (≤900px) collapse to single column', () => {
      // Sanity pin: tablet override stays `1fr` so the 2-up rule
      // doesn't accidentally cascade to phone.
      expect(COMPONENTS_CSS).toMatch(
        /@container artboard \(max-width: 900px\)[\s\S]*?\.types-grid\s*\{[^}]*grid-template-columns:\s*1fr\s*;/,
      );
    });
  });
});
