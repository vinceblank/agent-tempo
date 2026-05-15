// Sidebar — ensembles nav + global nav
const { useState: useStateSb } = React;

// Platform detection for keyboard shortcut hints (Mac uses ⌘, others use Ctrl)
window.IS_MAC = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");

const NAV_ICONS = {
  workspace: <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M4 12h10M4 18h16"/></svg>,
  overview:  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="3" y="15" width="7" height="6" rx="1.5"/><rect x="14" y="11" width="7" height="10" rx="1.5"/></svg>,
  library:   <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5v14M9 5v14M14 5l5 14M19 5l-5 14"/></svg>,
  settings:  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.7l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.7-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.7.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.7 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.7.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.7-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.7V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg>,
};

const PHONE_TABS = [
  { k: "workspace", label: "Now",       map: "workspace" },
  { k: "overview",  label: "Ensembles", map: "overview" },
  { k: "library",   label: "Library",   map: "loadouts" },
  { k: "settings",  label: "Settings",  map: "settings" },
];

function PhoneTabBar({ activeNav, onNav }) {
  // Map sidebar nav keys → phone tab keys for active state
  const navToTab = { workspace: "workspace", overview: "overview", loadouts: "library", types: "library", schedules: "library", hosts: "library", settings: "settings" };
  const activeTab = navToTab[activeNav] || "workspace";
  return (
    <nav className="phone-tabbar" role="navigation" aria-label="Primary">
      {PHONE_TABS.map(t => (
        <button
          key={t.k}
          type="button"
          className={"phone-tab" + (t.k === activeTab ? " is-active" : "")}
          onClick={() => onNav?.(t.map)}
          aria-current={t.k === activeTab ? "page" : undefined}
        >
          <span className="phone-tab-icon">{NAV_ICONS[t.k]}</span>
          <span className="phone-tab-label">{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

function PhoneAppBar({ activeEnsemble = "my-band", title, onMenu, onAction, actionIcon, actionLabel, actionActive, status, lineup }) {
  const ens = (window.ENSEMBLES || []).find(e => e.id === activeEnsemble);
  return (
    <header className="phone-appbar">
      <div className="phone-appbar-row">
        <button type="button" className="phone-appbar-btn" aria-label="Switch ensemble" onClick={onMenu}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
        </button>
        <div className="phone-appbar-title">
          <span className="phone-appbar-kicker">{lineup ? "lineup · " + lineup : "ensemble"}</span>
          <span className="phone-appbar-name"><span className="at">@</span>{ens?.name || activeEnsemble || "—"}</span>
        </div>
        <button
          type="button"
          className={"phone-appbar-btn" + (actionActive ? " is-active" : "")}
          aria-label={actionLabel || "More"}
          onClick={onAction}
        >
          {actionIcon || (
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
          )}
        </button>
      </div>
      {status && (
        <div className="phone-appbar-status mono">
          {status.active != null && <span className="phone-stat ok"><span className="phone-stat-dot" /> {status.active} active</span>}
          {status.idle != null && <span className="phone-stat dim">{status.idle} idle</span>}
          {status.detached > 0 && <span className="phone-stat warn">◐ {status.detached} detached</span>}
          {status.uptime && <span className="phone-stat dim">up {status.uptime}</span>}
        </div>
      )}
    </header>
  );
}

// Bottom-sheet ensemble switcher — slides up from the bottom on phone,
// centered modal-ish anywhere else. Tap an ensemble to switch; "+ New" routes
// to the create-ensemble screen.
function EnsembleSwitcher({ activeEnsemble, onSelect, onClose, onNew }) {
  const ens = window.ENSEMBLES || [];
  return (
    <div className="ens-switcher" role="dialog" aria-label="Switch ensemble" onClick={onClose}>
      <div className="ens-switcher-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="ens-switcher-grip" />
        <div className="ens-switcher-head">
          <div className="ens-switcher-title">Switch ensemble</div>
          <button type="button" className="ens-switcher-close" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="ens-switcher-list">
          {ens.map(e => (
            <button
              key={e.id}
              type="button"
              className={"ens-switcher-row" + (e.id === activeEnsemble ? " is-active" : "")}
              onClick={() => onSelect?.(e.id)}
            >
              <span className={"ens-switcher-dot" + (e.players > 0 ? " on" : "")} />
              <span className="ens-switcher-meta">
                <span className="ens-switcher-name"><span className="at">@</span>{e.name}</span>
                <span className="ens-switcher-sub">{e.players} players · {e.tempo} bpm</span>
              </span>
              {e.id === activeEnsemble && <span className="ens-switcher-check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
        <button type="button" className="ens-switcher-new" onClick={onNew}>
          <span className="ens-switcher-plus">+</span>
          <span>New ensemble…</span>
        </button>
      </div>
    </div>
  );
}

window.EnsembleSwitcher = EnsembleSwitcher;

window.PhoneTabBar = PhoneTabBar;
window.PhoneAppBar = PhoneAppBar;

function Sidebar({ activeEnsemble = "my-band", activeNav = "workspace", onNav, onSelectEnsemble, compact = false }) {
  const ens = window.ENSEMBLES;
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <window.Brandmark size="md" />
      </div>

      <div className="sidebar-section">
        <div className="sidebar-kicker">
          <span>Ensembles</span>
          <span className="count">{ens.filter(e => e.players > 0).length} · running</span>
        </div>
        {ens.map(e => (
          <div
            key={e.id}
            className={`ensemble-row ${e.id === activeEnsemble ? "is-active" : ""} ${e.players > 0 ? "has-active" : ""}`}
            onClick={() => onSelectEnsemble?.(e.id)}
          >
            <span className="er-dot" />
            <span className="er-initial" aria-hidden="true">{e.name.charAt(0).toUpperCase()}</span>
            <span className="col" style={{ gap: 0 }}>
              <span className="er-name">{e.name}</span>
              <span className="er-meta">{e.players} players · {e.tempo} bpm</span>
            </span>
            <span className="mono dim" style={{ fontSize: 10 }}>↵</span>
          </div>
        ))}
        <div className="ensemble-row ensemble-row--new" style={{ marginTop: 4, color: "var(--accent)" }} onClick={() => onNav?.("create-ensemble")}>
          <span className="icon-g" style={{ color: "var(--accent)" }}>+</span>
          <span className="er-name">New ensemble…</span>
          <span />
        </div>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-kicker">Library</div>
        {[
          { k: "overview",   icon: "◇", label: "Overview" },
          { k: "loadouts",   icon: "≡", label: "Loadouts" },
          { k: "types",      icon: "♪", label: "Player types" },
          { k: "schedules",  icon: "⧗", label: "Schedules" },
          { k: "hosts",      icon: "⌂", label: "Hosts" },
          { k: "settings",   icon: "⚙", label: "Settings" },
        ].map(r => (
          <div
            key={r.k}
            className={`nav-row ${r.k === activeNav ? "is-active" : ""}`}
            onClick={() => onNav?.(r.k)}
          >
            <span className="nav-icon">{r.icon}</span>
            <span>{r.label}</span>
          </div>
        ))}
      </div>

      <div className="sidebar-maestro" title="You — the maestro">
        <window.MaestroMark size={18} />
        <span style={{display:"flex", flexDirection:"column", lineHeight: 1.15, marginLeft: 8, flex: 1, minWidth: 0}}>
          <span style={{fontFamily:"var(--ff-display)", fontSize: 14, color: "var(--text)"}}>vinceblank</span>
          <span className="mono dim" style={{fontSize: 10}}>maestro</span>
        </span>
        <span className="mono dim" style={{fontSize: 10}}>⌥M</span>
      </div>

      <div className="sidebar-footer">
        <span><span className="conn-ok">●</span> localhost:7233</span>
        <span>v0.26</span>
      </div>
    </aside>
  );
}

window.Sidebar = Sidebar;

// ─────────────────────────────────────────────────────────────
// Ensemble workspace — the 90% screen
// ─────────────────────────────────────────────────────────────
function EnsembleWorkspace({ compact = false }) {
  const players = window.PLAYERS;
  const conductor = players.find(p => p.isConductor);
  const active = players.filter(p => ["attached", "processing", "awaiting"].includes(p.phase));
  const idle = players.filter(p => p.phase === "awaiting");
  const disconnected = players.filter(p => ["detached", "draining"].includes(p.phase));

  const [popped, setPopped] = React.useState(false);
  const [showSide, setShowSide] = React.useState(false);
  const [activeNav, setActiveNav] = React.useState("workspace");
  const [activeEnsemble, setActiveEnsemble] = React.useState("my-band");
  const [switcherOpen, setSwitcherOpen] = React.useState(false);

  // When the bottom tab routes away from the workspace, render the matching
  // library/overview/settings screen as the whole artboard.
  if (activeNav !== "workspace") {
    // "create-ensemble" opens the wizard as a modal over the workspace.
    if (activeNav === "create-ensemble") {
      // fall through — handled below as a modal overlay
    } else {
      const map = {
        overview:  window.Overview,
        loadouts:  window.Loadouts,
        types:     window.PlayerTypes,
        schedules: window.Schedules,
        hosts:     window.Hosts,
        settings:  window.Settings,
      };
      const Screen = map[activeNav];
      if (Screen) {
        return (
          <Screen
            activeNav={activeNav}
            activeEnsemble={activeEnsemble}
            onNav={setActiveNav}
            onSelectEnsemble={(id) => { setActiveEnsemble(id); setActiveNav("workspace"); }}
            onOpenSwitcher={() => setSwitcherOpen(true)}
          />
        );
      }
    }
  }

  const ens = (window.ENSEMBLES || []).find(e => e.id === activeEnsemble) || (window.ENSEMBLES || [])[0];
  const ensName = ens?.name || activeEnsemble;

  return (
    <div className={"artboard-body" + (popped ? " workspace-dimmed" : "")}>
      <div className="app-shell app-shell--workspace">
        <window.Sidebar
          activeEnsemble={activeEnsemble}
          activeNav={activeNav}
          onNav={setActiveNav}
          onSelectEnsemble={setActiveEnsemble}
        />
        <window.PhoneAppBar
          activeEnsemble={activeEnsemble}
          onMenu={() => setSwitcherOpen(true)}
          lineup="tempo-dev-team"
          status={{ active: active.length, idle: idle.length, detached: disconnected.length, uptime: "2h 14m" }}
          onAction={() => setShowSide(s => !s)}
          actionLabel={showSide ? "Hide roster" : "Show roster"}
          actionActive={showSide}
          actionIcon={
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="9" cy="8" r="3.2" />
              <path d="M2.5 19c0-3.4 2.9-5.5 6.5-5.5s6.5 2.1 6.5 5.5" />
              <circle cx="17" cy="7" r="2.4" />
              <path d="M15.5 13.2c2.4 0.5 5 2 5 5.3" />
            </svg>
          }
        />
        <main className="main">
          <header className="page-header">
            <div>
              <div className="page-title-row">
                <h1 className="page-title">
                  <span className="prefix mono">ensemble /</span>
                  <span className="at">@</span>{ensName}
                </h1>
                <div className="page-pills">
                  <span className="page-pill"><span className="pill-dot" /> <span className="pill-num">{active.length}</span> active</span>
                  <span className="page-pill"><span className="pill-num">{idle.length}</span> idle</span>
                  {disconnected.length > 0 && (
                    <span className="page-pill warn">◐ {disconnected.length} detached</span>
                  )}
                  <span className="page-pill">up <span className="pill-num">2h 14m</span></span>
                </div>
              </div>
              <div className="page-subtitle">
                Lineup <span className="mono">tempo-dev-team</span> · conducted by <span className="mono accent">conductor</span> on <span className="mono">studio.local</span>
              </div>
            </div>
            <div className="page-actions">
              <window.Btn variant="ghost" size="sm" icon="+">Recruit</window.Btn>
              <button
                className={"side-toggle" + (showSide ? " is-active" : "")}
                onClick={() => setShowSide(s => !s)}
                aria-label={showSide ? "Hide roster" : "Show roster, events, schedules"}
                title={showSide ? "Hide details" : "Show roster, events, schedules"}
              >
                <span className="st-icon" aria-hidden="true">
                  {/* people / roster glyph */}
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="9" cy="8" r="3.2" />
                    <path d="M2.5 19c0-3.4 2.9-5.5 6.5-5.5s6.5 2.1 6.5 5.5" />
                    <circle cx="17" cy="7" r="2.4" />
                    <path d="M15.5 13.2c2.4 0.5 5 2 5 5.3" />
                  </svg>
                </span>
                <span className="st-label">{showSide ? "Hide details" : "Details"}</span>
                <span className="st-badge mono">{players.length}</span>
              </button>
            </div>
          </header>

          {(window.__tweaks?.showTempoStrip !== false) && (
            <div className="page-tempo">
              <window.TempoStrip series={window.TEMPO_SERIES} bpm={92} />
            </div>
          )}

          <div className={"workspace" + (showSide ? "" : " workspace-collapsed")}>
            <section className="workspace-main">
              {popped ? (
                <div className="panel chat chat-stub" onClick={() => setPopped(false)}>
                  <div className="chat-stub-inner">
                    <div className="chat-stub-icon">↗</div>
                    <div className="chat-stub-title">Maestro chat is popped out</div>
                    <div className="chat-stub-sub mono dim">Click anywhere here, or close the floating window, to dock it back.</div>
                  </div>
                </div>
              ) : (
              <div className="panel chat">
                <div className="panel-head">
                  <div className="panel-head-title">
                    <span className="h">Maestro chat</span>
                    <span className="subj display">Conductor + ensemble feed</span>
                  </div>
                  <div className="row">
                    <window.Btn variant="ghost" size="sm" icon="⏸">Pause</window.Btn>
                    <span className="popout-btn"><window.Btn variant="ghost" size="sm" onClick={() => setPopped(true)}>↗ Pop out</window.Btn></span>
                  </div>
                </div>
                <div className="chat-log">
                  {window.FEED.map((m, i) => <FeedMessage key={i} m={m} />)}
                </div>
                <div className="composer">
                  <div className="composer-frame">
                    <textarea
                      className="composer-input"
                      rows="1"
                      placeholder="Message @conductor"
                      defaultValue="any blockers on the attachment-math extraction? and remind critic to pick up PR #287 when it re-attaches"
                      onInput={(e) => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px'; }}
                    />
                    <div className="composer-toolbar">
                      <div className="composer-tools">
                        <button className="composer-icon" title="Mention a player">@</button>
                        <button className="composer-icon" title="Slash command">/</button>
                      </div>
                      <div className="composer-send">
                        <span className="composer-hint mono dim" title={window.IS_MAC ? "Cmd + Return to send" : "Ctrl + Enter to send"}>{window.IS_MAC ? "⌘↩" : "Ctrl ↩"}</span>
                        <window.Btn variant="primary" size="md">Send</window.Btn>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              )}
            </section>

            {showSide && (
            <aside className="workspace-side">
              <div className="ws-side-sheet-grip" aria-hidden="true" />
              <button type="button" className="ws-side-sheet-close" onClick={() => setShowSide(false)} aria-label="Close details">×</button>
              <div className="panel">
                <div className="panel-head">
                  <div className="panel-head-title">
                    <span className="h">Roster</span>
                    <span className="subj display">{players.length} players</span>
                  </div>
                  <window.Btn variant="ghost" size="sm" icon="+">Recruit</window.Btn>
                </div>
                <div className="panel-body flush roster">
                  {players.map(p => (
                    <div key={p.id} className="roster-item">
                      <window.PlayerAvatar player={p} size={32} />
                      <div className="col" style={{ gap: 2 }}>
                        <div className="rn">
                          <span>{p.name}</span>
                          {p.isConductor && <span className="conductor-star" title="Conductor">★</span>}
                          <window.PhaseDot phase={p.phase} />
                        </div>
                        <div className="rp">
                          <window.TypeBadge type={p.type} />
                          <span style={{ marginLeft: 6 }}>{p.part}</span>
                        </div>
                      </div>
                      <div className="rmeta">
                        <div className="heartbeat">{p.heartbeat}</div>
                        <div>{p.messages} msg</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="panel">
                <div className="panel-head">
                  <div className="panel-head-title">
                    <span className="h">Event log</span>
                    <span className="subj display">System audit trail</span>
                  </div>
                  <span className="mono dim" style={{fontSize: 10}}>ring · max 200 · messages elided</span>
                </div>
                <div className="panel-body flush event-log">
                  {window.EVENTS.filter(e => e.kind !== "message").map((e, i) => (
                    <div key={i} className="event-row">
                      <span className="t">{e.t}</span>
                      <span className={`k ${e.kind}`}>{e.kind}</span>
                      <span>{e.body}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="panel">
                <div className="panel-head">
                  <div className="panel-head-title">
                    <span className="h">Schedules</span>
                    <span className="subj display">4 active</span>
                  </div>
                  <window.Btn variant="ghost" size="sm" icon="+">New</window.Btn>
                </div>
                <div className="panel-body" style={{paddingTop: 6}}>
                  {window.SCHEDULES.slice(0, 3).map(s => (
                    <window.KV key={s.name} k={s.name} v={s.next} />
                  ))}
                </div>
              </div>
            </aside>
            )}
            {showSide && <div className="ws-side-scrim" onClick={() => setShowSide(false)} aria-hidden="true" />}
          </div>
        </main>
        <window.PhoneTabBar activeNav={activeNav} onNav={setActiveNav} />
      </div>
      {switcherOpen && (
        <window.EnsembleSwitcher
          activeEnsemble={activeEnsemble}
          onSelect={(id) => { setActiveEnsemble(id); setSwitcherOpen(false); }}
          onClose={() => setSwitcherOpen(false)}
          onNew={() => { setSwitcherOpen(false); setActiveNav("create-ensemble"); }}
        />
      )}
      {activeNav === "create-ensemble" && (
        <div onClick={() => setActiveNav("workspace")} style={{position:"absolute", inset:0, zIndex: 60}}>
          <div onClick={(e)=>e.stopPropagation()} style={{position:"absolute", inset:0}}>
            <window.CreateEnsemble />
          </div>
          <button type="button" onClick={() => setActiveNav("workspace")} aria-label="Close" style={{position:"absolute", top: 14, right: 14, zIndex: 70, width:32, height:32, borderRadius:8, background:"rgba(0,0,0,0.4)", border:"1px solid var(--rule-strong)", color:"var(--text)", cursor:"pointer", fontSize:18}}>×</button>
        </div>
      )}
      {popped && (
        <>
          <div className="popout-scrim" onClick={() => setPopped(false)} />
          <div className="popout-window" onClick={(e) => e.stopPropagation()}>
            <div className="popout-chrome">
              <div className="popout-dots">
                <span className="popout-dot r" onClick={() => setPopped(false)} title="Dock back" />
                <span className="popout-dot y" />
                <span className="popout-dot g" />
              </div>
              <div className="popout-title mono">
                <span className="dim">agent-tempo · maestro chat ·</span> <span className="accent">@my-band</span>
              </div>
              <div className="popout-right mono dim"><span className="popout-pin">◈</span> always on top</div>
            </div>
            <div className="chat-log popout-log">
              {window.FEED.slice(-6).map((m, i) => <FeedMessage key={i} m={m} />)}
            </div>
            <div className="composer popout-composer">
              <textarea className="composer-input" rows="1" placeholder="Message @conductor — / for commands" defaultValue="" />
              <div className="composer-actions">
                <window.Btn variant="primary" size="sm">Send</window.Btn>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function FeedMessage({ m }) {
  if (m.kind === "out") {
    return (
      <div className="msg out">
        <div>
          <div className="msg-head">
            <span className="sender mono">you</span>
            <span className="arrow">→</span>
            <span className="target">{m.to}</span>
            <span className="time">{m.t}</span>
          </div>
          <div className="msg-body">{m.body}</div>
        </div>
      </div>
    );
  }
  if (m.kind === "route") {
    const player = window.PLAYERS.find(p => p.name === m.from) || { name: m.from, type: "tempo-conductor" };
    return (
      <div className="msg route">
        <div className="msg-avatar">
          <window.PlayerAvatar player={player} size={28} />
        </div>
        <div>
          <div className="msg-head">
            <span className="sender" style={{color: "var(--dim)"}}>{m.from}</span>
            <span className="arrow">→</span>
            <span className="target">{m.to}</span>
            <span className="time">{m.t}</span>
          </div>
          <div className="msg-body">{m.body}</div>
        </div>
      </div>
    );
  }
  // in-bound
  const player = window.PLAYERS.find(p => p.name === m.from) || { name: m.from, type: "tempo-soloist" };
  return (
    <div className="msg in">
      <div className="msg-avatar">
        <window.PlayerAvatar player={player} size={28} />
      </div>
      <div>
        <div className="msg-head">
          <span className="sender" style={{ color: `oklch(0.8 0.12 ${window.hueForType(player.type)})` }}>{m.from}</span>
          {player.isConductor && <span style={{color: "var(--warn)"}}>★</span>}
          <span className="arrow">←</span>
          <span className="target">maestro</span>
          <span className="time">{m.t}</span>
        </div>
        <div className="msg-body">{m.body}</div>
      </div>
    </div>
  );
}

window.EnsembleWorkspace = EnsembleWorkspace;
window.FeedMessage = FeedMessage;
