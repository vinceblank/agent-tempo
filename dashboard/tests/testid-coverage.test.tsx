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

  it('operator chrome (theme + density) is reachable on shell-only routes', () => {
    // PR-B Overview pushes its own PageHeader (Refresh + New ensemble),
    // so the AppShell's default operator chrome is hidden on `/`. The
    // chrome still renders on placeholder routes that don't override —
    // pick `/loadouts` since it's a stable PR-6 placeholder. PR-G will
    // migrate the chrome into `/settings` and this assertion can move
    // along with it (or retire entirely once SettingsSheet exposes the
    // same testids).
    const { getByTestId } = renderApp('/loadouts');
    expect(getByTestId('settings-theme-toggle')).toBeInTheDocument();
    expect(getByTestId('settings-density-slider')).toBeInTheDocument();
  });
});
