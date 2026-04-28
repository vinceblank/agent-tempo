/**
 * testid-coverage — architect's risk #12.
 *
 * Render the full AppShell + placeholder content, then crawl the DOM
 * for every interactive element. Each must carry either:
 *   - `data-testid="..."` (the stable test surface), or
 *   - `data-testid-exempt="<reason>"` (explicit opt-out — forces the
 *     author to think before omitting).
 *
 * The crawl targets `button`, `[role="button"]`, `input`, `select`,
 * `textarea`. Decorative SVGs/spans are not interactive and don't
 * need a testid.
 *
 * If this test fails, either tag the offending element or add an
 * exempt attribute with a one-word reason (`"decorative-glyph"`,
 * `"sr-only"`, etc.).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { App } from '../src/App';
import { createDashboardMemoryRouter } from '../src/router';
import { MockDashboardClient } from './fixtures/mock-client';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';

// `App` mounts a router (PR-4); we inject a memory router so jsdom
// doesn't need a real `window.location` matching `/dashboard/*`.
function renderApp(initialPath = '/') {
  const router = createDashboardMemoryRouter([initialPath]);
  return render(<App router={router} />);
}

beforeEach(() => {
  __setDashboardClientForTests(new MockDashboardClient({ ensembles: [] }));
});
afterEach(() => {
  __setDashboardClientForTests(null);
});

const INTERACTIVE_SELECTOR = [
  'button',
  '[role="button"]',
  'input',
  'select',
  'textarea',
].join(', ');

describe('testid coverage (architect risk #12)', () => {
  it('every interactive element has data-testid or data-testid-exempt', () => {
    const { container } = renderApp();
    const interactive = Array.from(container.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR));
    expect(interactive.length).toBeGreaterThan(0); // Sanity: AppShell isn't empty.
    const missing = interactive.filter(
      (el) => !el.hasAttribute('data-testid') && !el.hasAttribute('data-testid-exempt'),
    );
    if (missing.length > 0) {
      const summary = missing
        .map((el) => `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}>`)
        .join(', ');
      throw new Error(
        `Found ${missing.length} interactive element(s) without data-testid: ${summary}. ` +
          `Either tag them (see dashboard/README.md § Testability) or add data-testid-exempt="<reason>".`,
      );
    }
    expect(missing).toHaveLength(0);
  });

  it('first-class shell elements expose stable testids', () => {
    const { getByTestId } = renderApp();
    expect(getByTestId('app-shell')).toBeInTheDocument();
    expect(getByTestId('sidebar')).toBeInTheDocument();
    expect(getByTestId('page-header')).toBeInTheDocument();
    expect(getByTestId('brandmark')).toBeInTheDocument();
  });

  it('operator chrome (theme + density) is reachable in Settings', () => {
    // The AppShell's `DefaultActions` (theme toggle + density slider) is
    // a fallback that renders only when no screen pushes a PageHeader
    // override. Post-#389 R3.P1.3, every Library route (Loadouts /
    // Schedules / PlayerTypes / Hosts) pushes its own header and Settings
    // owns the canonical theme/density controls — so the fallback chrome
    // is no longer the canonical surface. The assertion now points at
    // Settings's own controls (`settings-theme-select` /
    // `settings-density-range`) which are the user-facing canonical home
    // for theme/density per PR-G of #389.
    const { getByTestId } = renderApp('/settings');
    expect(getByTestId('settings-theme-select')).toBeInTheDocument();
    expect(getByTestId('settings-density-range')).toBeInTheDocument();
  });
});
