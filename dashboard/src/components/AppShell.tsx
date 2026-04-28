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
 *    chrome reachable. PR-G's Settings page (sibling route) now owns
 *    the canonical theme/density/accent UI; this fallback is mostly a
 *    bridge for routes without a screen-pushed header.
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
import { PhoneAppBar, type PhoneAppBarStatus } from './PhoneAppBar';
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

/**
 * Per-screen PhoneAppBar configuration the Workspace screen pushes via
 * {@link useScreenPhoneAppBar}. AppShell merges the override on top of
 * its own `activeEnsemble` + `onMenu` (the hamburger always opens the
 * EnsembleSwitcher) and passes the result to PhoneAppBar.
 *
 * Excludes `activeEnsemble` (AppShell owns it from `useParams`) and
 * `onMenu` (AppShell owns the switcher state). All other PhoneAppBar
 * props are forwardable so screens can light up the lineup kicker, the
 * 4-pill status row, and the right-button action toggle.
 */
export interface PhoneAppBarOverride {
  lineup?: string;
  status?: PhoneAppBarStatus;
  onAction?: () => void;
  actionIcon?: ReactNode;
  actionLabel?: string;
  actionActive?: boolean;
}

type PhoneAppBarSlotState = PhoneAppBarOverride | null;
interface PhoneAppBarSlotApi {
  setOverride: (override: PhoneAppBarOverride | null) => void;
}
const PhoneAppBarSlotContext = createContext<PhoneAppBarSlotApi>({
  setOverride: () => {},
});

/**
 * Push per-screen props into the AppShell's PhoneAppBar (the bar
 * AppShell renders for the ≤520px viewport). Workspace uses this to
 * light up the lineup kicker + status row + roster-toggle action button.
 *
 * Wrap the override object in `useMemo` — the slot does identity-gated
 * updates so a stable reference avoids re-renders when the parent
 * re-renders for unrelated reasons.
 *
 * No-ops outside an AppShell (component tests rendering screens
 * standalone).
 *
 * Note: takes the override object directly (not a render-fn closure
 * like {@link useScreenPageHeader}). The asymmetry is deliberate —
 * PhoneAppBar is AppShell-only (not screen-swappable like PageHeader,
 * which Workspace replaces inline), so the slot's value is always a
 * small config bag rather than a render fn. Sticking to a plain object
 * keeps the call site simpler at the cost of consistency with the
 * sibling slot.
 */
export function useScreenPhoneAppBar(override: PhoneAppBarOverride): void {
  const { setOverride } = useContext(PhoneAppBarSlotContext);
  useEffect(() => {
    setOverride(override);
    return () => setOverride(null);
  }, [override, setOverride]);
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
  const headerApi = useMemo(() => ({ setRender }), [setRender]);

  // Phone-app-bar override slot — same identity-gated pattern as the
  // header slot so a redundant `setOverride(sameObj)` doesn't churn.
  const [phoneOverride, setPhoneOverride] = useState<PhoneAppBarSlotState>(null);
  const setPhoneOverrideStable = useCallback(
    (next: PhoneAppBarOverride | null) => {
      setPhoneOverride((prev) => {
        if (next === null) return prev === null ? prev : null;
        if (prev === next) return prev;
        return next;
      });
    },
    [],
  );
  const phoneApi = useMemo(
    () => ({ setOverride: setPhoneOverrideStable }),
    [setPhoneOverrideStable],
  );

  return (
    <PageHeaderSlotContext.Provider value={headerApi}>
     <PhoneAppBarSlotContext.Provider value={phoneApi}>
      <div className="artboard-body">
        <div
          className={'app-shell' + (isWorkspace ? ' app-shell--workspace' : '')}
          data-testid="app-shell"
        >
          <Sidebar />
          <PhoneAppBar
            activeEnsemble={activeEnsemble}
            onMenu={() => setSwitcherOpen(true)}
            lineup={phoneOverride?.lineup}
            status={phoneOverride?.status}
            onAction={phoneOverride?.onAction}
            actionIcon={phoneOverride?.actionIcon}
            actionLabel={phoneOverride?.actionLabel}
            actionActive={phoneOverride?.actionActive}
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
     </PhoneAppBarSlotContext.Provider>
    </PageHeaderSlotContext.Provider>
  );
}
