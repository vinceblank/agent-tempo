/**
 * Settings — sidebar-routed page. PR-G of #389.
 *
 * Five panels in a 2-column `.settings-grid` that collapses to one
 * column at ≤720px (existing CSS at components.css line 1597+):
 *
 *   ┌─ Connection ─────────────┐ ┌─ Profile ────────────────┐
 *   │ namespace, address, …    │ │ display name, email, …   │
 *   └──────────────────────────┘ └──────────────────────────┘
 *   ┌─ Notifications ──────────┐ ┌─ Appearance ─────────────┐
 *   │ player detached, …       │ │ theme, density, accent…  │
 *   └──────────────────────────┘ └──────────────────────────┘
 *   ┌─ Danger zone (full-width, gridColumn 1/-1) ────────────┐
 *   │ Disband all ensembles • Reset client state            │
 *   └────────────────────────────────────────────────────────┘
 *
 * Most KV pairs are placeholders for v1 — wire-up to live config
 * (Connection / Profile / Notifications) lands in PR-7 alongside the
 * safe-write surface. Appearance is the live panel: it shows the
 * Zustand prefs values + provides the actual editing controls.
 *
 * Replaces the old `SettingsSheet.tsx` which is deleted in this PR.
 * The existing prefs store + log telemetry are unchanged.
 *
 * Source: docs/design/dashboard-handoff/project/screens.jsx Settings
 * (lines 536-645) + audit §6 PR-G (lines 1052-1071).
 *
 * Pixel-audit v0.28.9 — PR-G design-canvas decisions (ST-1/2/3/4):
 *   - ST-1: Connection panel KEEPS the impl-added `version` row
 *     (wired to `/v1/health` per #436/#444) — useful for support/debug.
 *   - ST-2: Appearance panel KEEPS impl's live editing controls; the
 *     canonical static-KV mock is scaffolding. Ratified in PR-G-docs
 *     (#458) — see the comment block in screens.jsx:Settings().
 *   - ST-3: Appearance panel does NOT render the canonical mock's
 *     `metronome = on` row — `metronome` isn't a real Settings semantic
 *     in claude-tempo; the canvas mock is design-time scaffolding.
 *   - ST-4: Profile + Notifications panels intentionally show `—`
 *     placeholders — the underlying account-mgmt / notif-prefs surfaces
 *     are wire-pending; blank placeholders are honest until they ship.
 *
 * The corresponding pin tests live in
 * `dashboard/tests/settings-page.test.tsx` so the next pixel audit
 * doesn't re-flag these intentional divergences as drift.
 */
import { useCallback, useState } from 'react';
import { useHealth } from '../lib/queries';
import {
  DEFAULT_ACCENT,
  DEFAULT_DENSITY,
  DEFAULT_THEME,
  usePrefs,
  type Accent,
  type Density,
  type Theme,
} from '../store/prefs';
import { logEvent } from '../lib/log';
import { toastSuccess } from '../lib/toast';
import { PageHeader } from '../components/PageHeader';
import { useScreenPageHeader } from '../components/AppShell';
import { DisabledWithTooltip } from '../components/DisabledWithTooltip';

const DEBUG_FLAG_KEY = 'claudeTempoDebug';

const ACCENT_LABELS: Record<Accent, string> = {
  terracotta: 'Terracotta',
  sage: 'Sage',
  plum: 'Plum',
};

const DENSITY_VALUES: readonly Density[] = [4, 5, 6, 7, 8, 9];

/** Read once at render time — not a Zustand subscription, so the page
 *  doesn't re-render when other surfaces toggle this flag. The
 *  Appearance panel's checkbox writes directly. */
function readDebugFlag(): boolean {
  try {
    return window.localStorage?.getItem(DEBUG_FLAG_KEY) === 'true';
  } catch {
    return false;
  }
}

export function Settings() {
  // Hoist the PageHeader render fn out of the JSX so the closure
  // identity is stable across re-renders that don't change the title —
  // matches the `useScreenPageHeader` slot's identity-gate contract.
  const renderHeader = useCallback(
    () => (
      <PageHeader
        title="Settings"
        subtitle="Maestro client preferences and Temporal connection."
      />
    ),
    [],
  );
  useScreenPageHeader(renderHeader);

  return (
    <section data-testid="settings-page" className="settings-grid">
      <ConnectionPanel />
      <ProfilePanel />
      <NotificationsPanel />
      <AppearancePanel />
      <DangerZonePanel />
    </section>
  );
}

// ── Panels ────────────────────────────────────────────────────────────

function ConnectionPanel() {
  const { data: health, isLoading, isError } = useHealth();

  // Derive display values from live health data; fall back to "…" while
  // loading and "?" on error so the panel never shows stale hard-coded
  // defaults. `address` is the last static KV — pending a daemon-side
  // bind-address surface in `/v1/health`.
  const namespace = isLoading ? '…' : isError ? '?' : (health?.namespace ?? '?');
  const taskQueue = isLoading ? '…' : isError ? '?' : (health?.taskQueue ?? '?');
  const version = isLoading ? '…' : isError ? '?' : (health?.version ?? '?');

  return (
    <div className="panel settings-panel" data-testid="settings-panel-connection">
      <div className="panel-head">
        <div className="panel-head-title">
          <span className="h">Connection</span>
          <span className="subj display">Temporal namespace</span>
        </div>
        {/* `connected` is the design's literal label; live status will
          * read `useEnsembleList`'s `isError` state in PR-7. */}
        <span className="page-pill" data-testid="settings-connection-status">
          <span className="pill-dot" /> connected
        </span>
      </div>
      <div className="panel-body">
        <KV k="namespace" v={namespace} mono />
        <KV k="address" v="localhost:7233" mono />
        <KV k="task queue" v={taskQueue} mono />
        <KV k="version" v={version} mono />
        <KV k="tls" v="off" mono />
        <KV k="auth" v="—" mono />
      </div>
    </div>
  );
}

function ProfilePanel() {
  return (
    <div className="panel settings-panel" data-testid="settings-panel-profile">
      <div className="panel-head">
        <div className="panel-head-title">
          <span className="h">Profile</span>
          <span className="subj display">Your maestro identity</span>
        </div>
      </div>
      <div className="panel-body">
        <KV k="display name" v="—" mono />
        <KV k="email" v="—" mono />
        <KV k="default lineup" v="tempo-dev-team" mono />
        <KV k="default host" v="—" mono />
      </div>
    </div>
  );
}

function NotificationsPanel() {
  return (
    <div className="panel settings-panel" data-testid="settings-panel-notifications">
      <div className="panel-head">
        <div className="panel-head-title">
          <span className="h">Notifications</span>
          <span className="subj display">When the maestro should ping you</span>
        </div>
      </div>
      <div className="panel-body">
        <KV k="player detached" v="banner" />
        <KV k="conductor handoff" v="banner + sound" />
        <KV k="schedule fired" v="silent" />
        <KV k="recruit failed" v="banner" />
      </div>
    </div>
  );
}

function AppearancePanel() {
  const theme = usePrefs((s) => s.theme);
  const density = usePrefs((s) => s.density);
  const accent = usePrefs((s) => s.accent);
  const setTheme = usePrefs((s) => s.setTheme);
  const setDensity = usePrefs((s) => s.setDensity);
  const setAccent = usePrefs((s) => s.setAccent);

  return (
    <div className="panel settings-panel" data-testid="settings-panel-appearance">
      <div className="panel-head">
        <div className="panel-head-title">
          <span className="h">Appearance</span>
          <span className="subj display">Theme &amp; density</span>
        </div>
        <span className="mono dim" style={{ fontSize: 10 }}>
          see Tweaks ⌥T
        </span>
      </div>
      <div className="panel-body">
        <SettingRow label="Theme" htmlFor="settings-theme">
          <select
            id="settings-theme"
            data-testid="settings-theme-select"
            value={theme}
            onChange={(e) => setTheme(e.target.value as Theme)}
            style={SELECT_STYLE}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </SettingRow>

        <SettingRow label={`Density: ${density}`} htmlFor="settings-density">
          <input
            id="settings-density"
            data-testid="settings-density-range"
            type="range"
            min={DENSITY_VALUES[0]}
            max={DENSITY_VALUES[DENSITY_VALUES.length - 1]}
            step={1}
            value={density}
            onChange={(e) => {
              const next = Number(e.target.value);
              if (next >= 4 && next <= 9) setDensity(next as Density);
            }}
          />
        </SettingRow>

        <SettingRow label="Accent" htmlFor="settings-accent">
          <select
            id="settings-accent"
            data-testid="settings-accent-select"
            value={accent}
            onChange={(e) => setAccent(e.target.value as Accent)}
            style={SELECT_STYLE}
          >
            {(Object.keys(ACCENT_LABELS) as Accent[]).map((a) => (
              <option key={a} value={a}>
                {ACCENT_LABELS[a]}
              </option>
            ))}
          </select>
        </SettingRow>

        <DebugFlagRow />
      </div>
    </div>
  );
}

function DangerZonePanel() {
  return (
    <div
      className="panel settings-panel"
      data-testid="settings-panel-danger-zone"
      style={{ gridColumn: '1 / -1' }}
    >
      <div className="panel-head">
        <div className="panel-head-title">
          <span className="h">Danger zone</span>
          <span className="subj display">Destructive actions</span>
        </div>
      </div>
      <div className="panel-body">
        <div className="settings-danger-row">
          <div>
            <div style={{ fontWeight: 500 }}>Disband all ensembles</div>
            <div className="mono dim" style={{ fontSize: 11 }}>
              Stops all running players and clears outboxes. Sessions can be resumed later.
            </div>
          </div>
          <DisabledWithTooltip
            testId="settings-disband-all"
            action="settings.disband-all"
            reason="Disbanding every ensemble at once requires a daemon endpoint that hasn't shipped yet. Use `claude-tempo down --destroy` from the CLI for now."
          >
            Disband all
          </DisabledWithTooltip>
        </div>
        <div className="settings-danger-row">
          <div>
            <div style={{ fontWeight: 500 }}>Reset client state</div>
            <div className="mono dim" style={{ fontSize: 11 }}>
              Clears local preferences, recently-used loadouts, and chat drafts.
            </div>
          </div>
          <ResetClientStateButton />
        </div>
      </div>
    </div>
  );
}

/**
 * Reset — clears the prefs store + debug flag. The audit lists this in
 * the Danger zone alongside Disband, but unlike Disband it has no
 * server-side blast radius (only localStorage), so we wire it for real
 * in v1. The action goes through the public store setters so the
 * `prefs-*-set` log lines fire and the conductor's autonomous validator
 * sees each change.
 */
function ResetClientStateButton() {
  const setTheme = usePrefs((s) => s.setTheme);
  const setDensity = usePrefs((s) => s.setDensity);
  const setAccent = usePrefs((s) => s.setAccent);
  return (
    <button
      type="button"
      data-testid="settings-reset"
      className="btn btn-ghost btn-sm"
      onClick={() => {
        setTheme(DEFAULT_THEME);
        setDensity(DEFAULT_DENSITY);
        setAccent(DEFAULT_ACCENT);
        try {
          window.localStorage?.removeItem(DEBUG_FLAG_KEY);
        } catch {
          /* ignore */
        }
        logEvent('settings.reset', {});
        toastSuccess('Settings reset to defaults');
      }}
    >
      Reset
    </button>
  );
}

/** Shared select styling — matches the prior SettingsSheet visual.
 *  Inline rather than a CSS class so the screen owns its look without
 *  adding a one-off `.settings-select` rule to components.css. */
const SELECT_STYLE: React.CSSProperties = {
  background: 'var(--bg-2)',
  color: 'var(--text)',
  border: '1px solid var(--rule)',
  borderRadius: 6,
  padding: '6px 10px',
  fontFamily: 'var(--ff-display)',
  fontSize: 13,
  minWidth: 140,
};

// ── Helpers ───────────────────────────────────────────────────────────

interface KVProps {
  k: string;
  v: string;
  /** Apply mono font to the value (per design — used for technical values). */
  mono?: boolean;
}

function KV({ k, v, mono = false }: KVProps) {
  return (
    <div className="kv">
      <span className="kv-k">{k}</span>
      {/* F-B-5 (#461): title exposes full value when kv-v is ellipsis-truncated */}
      <span className={'kv-v' + (mono ? ' mono' : '')} title={String(v)}>{v}</span>
    </div>
  );
}

interface SettingRowProps {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}

function SettingRow({ label, htmlFor, children }: SettingRowProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '6px 0',
      }}
    >
      <label htmlFor={htmlFor} style={{ fontFamily: 'var(--ff-display)', fontSize: 13 }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function DebugFlagRow() {
  const [enabled, setEnabled] = useState(() => readDebugFlag());

  // Write directly inside the change handler instead of via `useEffect`.
  // The effect-on-mount fires a redundant write reading the flag we
  // just hydrated from. Direct writes also keep localStorage and React
  // state in lock-step without an extra render tick.
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.checked;
    setEnabled(next);
    try {
      if (next) window.localStorage?.setItem(DEBUG_FLAG_KEY, 'true');
      else window.localStorage?.removeItem(DEBUG_FLAG_KEY);
    } catch {
      /* ignore quota / private mode */
    }
    logEvent('settings.changed', { key: 'debug', value: next });
  };

  return (
    <SettingRow label="Debug logs" htmlFor="settings-debug">
      <input
        id="settings-debug"
        data-testid="settings-debug-checkbox"
        type="checkbox"
        checked={enabled}
        onChange={handleChange}
      />
    </SettingRow>
  );
}
