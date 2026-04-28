/**
 * AppShell — the persistent outer chrome.
 *
 * Layout (per audit, components.css `.app-shell` rules):
 *
 *   ┌──────────────────────────────────────────────────────┐  ← .artboard-body
 *   │ ┌────────┬───────────────────────────────────────┐  │     (container)
 *   │ │Sidebar │ PhoneAppBar (≤520px only)             │  │
 *   │ │  244px │ ─────────────────────────────────────  │  │
 *   │ │  →64px │ <main> rendering routed <Outlet />     │  │
 *   │ │  →hide │                                        │  │
 *   │ │        │ ─────────────────────────────────────  │  │
 *   │ │        │ PhoneTabBar (≤520px only)             │  │
 *   │ └────────┴───────────────────────────────────────┘  │
 *   └──────────────────────────────────────────────────────┘
 *
 * The outermost `.artboard-body` element is what the `@container artboard
 * (max-width: …)` rules in components.css are scoped against. Putting it
 * here (rather than at `<html>`) keeps the dashboard's responsive grid
 * driven by its own width rather than the viewport's, so future
 * embedding scenarios (split-pane dev tooling, picture-in-picture)
 * flow correctly.
 *
 * Mobile shell (PhoneAppBar / PhoneTabBar / EnsembleSwitcher) lit up
 * in PR-A1m. AppShell threads `activeEnsemble` from `useParams<{ id }>()`
 * into PhoneAppBar's title + EnsembleSwitcher's active-row treatment, and
 * owns the switcher open/close state. Outside `/ensemble/:id` the param
 * is `undefined`, which leaves both surfaces in their no-ensemble state
 * (em-dash title, no row highlighted).
 *
 * **Header policy** (PR-C1 + PR-B of #389 — two complementary mechanisms):
 *
 * 1. **Workspace** (`/ensemble/:id`, PR-C1): the screen renders its own
 *    composite PageHeader + page-tempo + workspace grid. AppShell stays
 *    out of the way — `children` go straight into `<main>` with no
 *    PageHeader and no `.page-pad` wrapper. The `app-shell--workspace`
 *    modifier fires the phone-breakpoint rule that hides the title bar
 *    (components.css line 1264-1267).
 *
 * 2. **All other routes**: AppShell renders a PageHeader above a
 *    scrolling `.page-pad` wrapping the routed content. Screens that
 *    own their own PageHeader (Overview/PR-B, future Hosts/etc.) push
 *    it via {@link useScreenPageHeader} — when the slot is set the
 *    override replaces the default operator chrome (density slider +
 *    theme toggle). When no override is pushed, the default keeps the
 *    chrome reachable until SettingsSheet absorbs it in PR-G.
 *
 * The slot Provider wraps the whole shell so `useScreenPageHeader`
 * resolves cleanly even on Workspace routes (it just no-ops there since
 * the slot is never rendered — Workspace draws its header inline).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { PageHeader } from './PageHeader';
import { PhoneAppBar } from './PhoneAppBar';
import { PhoneTabBar } from './PhoneTabBar';
import { EnsembleSwitcher } from './EnsembleSwitcher';

interface AppShellProps {
  children?: ReactNode;
}

/**
 * The PageHeader override slot — a render function pushed by the
 * currently-mounted screen via {@link useScreenPageHeader}. AppShell
 * calls it inside `<main>` above the page-pad on non-Workspace routes;
 * Workspace draws its own header inline so the slot is never read
 * there.
 *
 * State is held as an object wrapper (`{ render }`) rather than the
 * bare function so React's `useState` doesn't unwrap it, and so the
 * setter can identity-compare the user's render fn (not a per-call
 * wrapper) for the bail-out path.
 */
type PageHeaderRender = () => ReactNode;
type PageHeaderSlotState = { render: PageHeaderRender } | null;
interface PageHeaderSlotApi {
  setRender: (render: PageHeaderRender | null) => void;
}
const PageHeaderSlotContext = createContext<PageHeaderSlotApi>({
  setRender: () => {},
});

/**
 * Push a per-screen PageHeader into the AppShell slot. Replaces the
 * default operator chrome while the calling screen is mounted; the
 * default returns when the screen unmounts.
 *
 * Pass a render function (a closure that returns the PageHeader node).
 * Using a function rather than a node avoids re-render thrash when the
 * caller's parent re-renders for reasons unrelated to the header
 * content — only the closure identity gates the re-set.
 *
 * Wrap the render fn in `useCallback` (with the props the header reads
 * as dependencies) so the slot doesn't churn on every parent render.
 *
 * No-ops when called outside an AppShell (e.g. component tests that
 * render the screen standalone), and no-ops on Workspace routes where
 * the slot's render output is never read.
 */
export function useScreenPageHeader(render: PageHeaderRender): void {
  const { setRender } = useContext(PageHeaderSlotContext);
  useEffect(() => {
    setRender(render);
    return () => setRender(null);
  }, [render, setRender]);
}

export function AppShell({ children }: AppShellProps) {
  const location = useLocation();
  const isWorkspace = location.pathname.startsWith('/ensemble/');
  // Active ensemble for the mobile chrome — `useParams` resolves the
  // matched `:id` param when AppShell sits inside an `/ensemble/:id`
  // route, and returns `{}` everywhere else (em-dash title fallback).
  const { id: activeEnsemble } = useParams<{ id?: string }>();
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const [override, setOverride] = useState<PageHeaderSlotState>(null);
  // Identity-gate the wrapper rebuild so a redundant `setRender(sameFn)`
  // (e.g. StrictMode double-fire on mount) doesn't tear down the slot
  // and re-render the shell.
  const setRender = useCallback((render: PageHeaderRender | null) => {
    setOverride((prev) => {
      if (render === null) return prev === null ? prev : null;
      if (prev?.render === render) return prev;
      return { render };
    });
  }, []);
  const api = useMemo(() => ({ setRender }), [setRender]);

  return (
    <PageHeaderSlotContext.Provider value={api}>
      <div className="artboard-body">
        <div
          className={'app-shell' + (isWorkspace ? ' app-shell--workspace' : '')}
          data-testid="app-shell"
        >
          <Sidebar />
          <PhoneAppBar
            activeEnsemble={activeEnsemble}
            onMenu={() => setSwitcherOpen(true)}
          />
          <main className="main" data-testid="app-shell-main">
            {isWorkspace ? (
              // Workspace owns its full main column — header, tempo
              // strip, grid. AppShell hands children through unwrapped.
              children
            ) : (
              <>
                {override ? override.render() : <PageHeader title="Maestro" />}
                <div
                  className="page-pad scroll"
                  data-testid="app-shell-content"
                  style={{
                    // The `.page-pad.scroll` selector handles padding and
                    // overflow at every density step; the inline `display:flex`
                    // is purely so screens that render their own grids/sections
                    // get a vertical stacking context.
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--density-gap)',
                  }}
                >
                  {children}
                </div>
              </>
            )}
          </main>
          <PhoneTabBar />
          <EnsembleSwitcher
            open={switcherOpen}
            onClose={() => setSwitcherOpen(false)}
            activeEnsemble={activeEnsemble}
          />
        </div>
      </div>
    </PageHeaderSlotContext.Provider>
  );
}
