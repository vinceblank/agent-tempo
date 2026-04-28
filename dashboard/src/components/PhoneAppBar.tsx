/**
 * PhoneAppBar — top app bar shown at viewports ≤520px. PR-A1m of #389.
 *
 * Layout (matches the `.phone-appbar*` rules in components.css):
 *
 *   ┌─────────────────────────────────────────────────────────┐ ← .phone-appbar
 *   │ [☰] [kicker · lineup]              [⋯] │ ← .phone-appbar-row (52px)
 *   │     [@ensemble]                          │
 *   │ ─ optional .phone-appbar-status row ─ │
 *   └─────────────────────────────────────────────────────────┘
 *
 * The hamburger (☰) opens the EnsembleSwitcher; the right button is a
 * caller-controlled action slot (defaults to a 3-dot overflow icon).
 * `status` is an optional 4-pill row (active / idle / detached / uptime)
 * — screens that don't have status data omit the prop.
 *
 * Hidden by default; only shown when the artboard container query at
 * `(max-width: 520px)` fires. Above that breakpoint the Sidebar takes over.
 */
import type { ReactNode } from 'react';

export interface PhoneAppBarStatus {
  active?: number;
  idle?: number;
  detached?: number;
  uptime?: string;
}

interface PhoneAppBarProps {
  /** Active ensemble name — rendered after `@`. Falls back to `—`. */
  activeEnsemble?: string;
  /** Lineup label for the mono kicker (`lineup · {lineup}`). When omitted,
   *  kicker reads `ensemble` so the row never collapses. */
  lineup?: string;
  /** Hamburger handler. Wired to EnsembleSwitcher.open by AppShell. */
  onMenu?: () => void;
  /** Optional secondary-action handler for the right button. Workspace
   *  uses this for a roster slide-in toggle; other screens leave it
   *  pointing at the 3-dot overflow stub. */
  onAction?: () => void;
  /** Custom icon for the right button — defaults to the 3-dot overflow. */
  actionIcon?: ReactNode;
  /** Aria-label for the right button. Defaults to `More`. */
  actionLabel?: string;
  /** Adds the `is-active` modifier to the right button (terracotta tint)
   *  so toggle-style actions reflect their open state. */
  actionActive?: boolean;
  /** Optional 4-pill status row. Rendered only when truthy. */
  status?: PhoneAppBarStatus;
}

/** Hamburger icon — three horizontal lines. */
function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

/** 3-dot overflow icon — the default `actionIcon`. */
function OverflowIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </svg>
  );
}

export function PhoneAppBar({
  activeEnsemble,
  lineup,
  onMenu,
  onAction,
  actionIcon,
  actionLabel = 'More',
  actionActive = false,
  status,
}: PhoneAppBarProps) {
  return (
    <header className="phone-appbar" data-testid="phone-appbar" aria-label="Mobile top bar">
      <div className="phone-appbar-row">
        <button
          type="button"
          className="phone-appbar-btn"
          aria-label="Switch ensemble"
          onClick={onMenu}
          data-testid="phone-appbar-menu"
        >
          <MenuIcon />
        </button>
        <div className="phone-appbar-title">
          <span className="phone-appbar-kicker">
            {lineup ? `lineup · ${lineup}` : 'ensemble'}
          </span>
          {/* On routes outside any ensemble (e.g. `/dashboard`,
            * `/dashboard/loadouts`) the selector falls back to `@—`
            * which reads as a placeholder bug rather than an empty
            * state. Suppress the chunk entirely there — kicker +
            * hamburger conveys the empty-context state without the
            * em-dash sentinel. */}
          {activeEnsemble && (
            <span
              className="phone-appbar-name"
              data-testid="phone-appbar-ensemble-name"
            >
              <span className="at">@</span>
              {activeEnsemble}
            </span>
          )}
        </div>
        <button
          type="button"
          className={'phone-appbar-btn' + (actionActive ? ' is-active' : '')}
          aria-label={actionLabel}
          aria-pressed={actionActive || undefined}
          onClick={onAction}
          data-testid="phone-appbar-action"
        >
          {actionIcon ?? <OverflowIcon />}
        </button>
      </div>
      {status && (
        <div className="phone-appbar-status mono" data-testid="phone-appbar-status">
          {status.active != null && (
            <span className="phone-stat ok">
              <span className="phone-stat-dot" /> {status.active} active
            </span>
          )}
          {status.idle != null && <span className="phone-stat dim">{status.idle} idle</span>}
          {status.detached != null && status.detached > 0 && (
            <span className="phone-stat warn">◐ {status.detached} detached</span>
          )}
          {status.uptime && <span className="phone-stat dim">up {status.uptime}</span>}
        </div>
      )}
    </header>
  );
}
