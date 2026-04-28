// Supporting screens: Overview, Player detail sheet, Recruit wizard,
// Create Ensemble wizard, Loadouts, Player types, Schedules, Hosts, Settings.

function Overview({ activeNav = "overview", onNav, activeEnsemble = "my-band", onSelectEnsemble, onOpenSwitcher } = {}) {
  return (
    <div className="artboard-body">
      <div className="app-shell">
        <window.Sidebar activeEnsemble={activeEnsemble} activeNav={activeNav} onNav={onNav} onSelectEnsemble={onSelectEnsemble} />
        <window.PhoneAppBar activeEnsemble={activeEnsemble} onMenu={onOpenSwitcher} />
        <main className="main">
          <header className="page-header">
            <div>
              <div className="page-title-row">
                <h1 className="page-title">Overview</h1>
                <div className="page-pills">
                  <span className="page-pill"><span className="pill-dot" /> <span className="pill-num">3</span> ensembles</span>
                  <span className="page-pill"><span className="pill-num">13</span> players</span>
                  <span className="page-pill"><span className="pill-num">4</span> hosts</span>
                </div>
              </div>
              <div className="page-subtitle">All ensembles, rolled up. Tap one to dive in.</div>
            </div>
            <div className="page-actions">
              <window.Btn variant="ghost" size="sm" icon="↻">Refresh</window.Btn>
              <window.Btn variant="primary" size="sm" icon="+">New ensemble</window.Btn>
            </div>
          </header>

          <div className="page-pad scroll">
            <window.SectionHead kicker="I / RUNNING" title="Active ensembles" />
            <div className="ensemble-grid">
              {window.ENSEMBLES.map(e => (
                <div key={e.id} className={`ensemble-card ${e.players === 0 ? "is-empty" : ""}`}>
                  <div className="ec-head">
                    <div className="ec-name">
                      <span className="at">@</span>{e.name}
                    </div>
                    <div className="ec-tempo">
                      <span className="bpm">{e.tempo || "—"}</span>
                      <span>bpm</span>
                    </div>
                  </div>
                  <div className="ec-desc">{e.description}</div>
                  <div className="ec-stats">
                    <div className="ec-stat"><div className="n">{e.players}</div><div className="l">players</div></div>
                    <div className="ec-stat"><div className="n" style={{color: e.active > 0 ? "var(--ok)" : "var(--dim)"}}>{e.active}</div><div className="l">active</div></div>
                    <div className="ec-stat"><div className="n" style={{fontSize: 12, fontFamily: "var(--ff-mono)"}}>{e.uptime}</div><div className="l">uptime</div></div>
                  </div>
                  <div style={{fontFamily:"var(--ff-mono)", fontSize: 11, color:"var(--dim)", display:"flex", justifyContent:"space-between"}}>
                    <span>{e.lineup}</span>
                    <span>{e.host}</span>
                  </div>
                  {e.players > 0 && (
                    <div className="ec-roster">
                      {window.PLAYERS.slice(0, Math.min(5, e.players)).map(p => (
                        <window.PlayerAvatar key={p.id} player={p} size={22} />
                      ))}
                      {e.players > 5 && <span className="mono dim" style={{alignSelf:"center", marginLeft: 4, fontSize: 11}}>+{e.players-5}</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div style={{marginTop: 28}}>
              <window.SectionHead kicker="II / RECENT" title="Recent activity" right={<span className="mono dim" style={{fontSize:11}}>across all ensembles</span>} />
              <div className="panel">
                <div className="panel-body flush event-log">
                  {[
                    { t: "14:23:08", k: "route",    body: "my-band · conductor → critic" },
                    { t: "14:22:41", k: "message",  body: "my-band · lead → ensemble (PR #287)" },
                    { t: "14:19:00", k: "schedule", body: "backend-team · status-check fired" },
                    { t: "14:18:22", k: "phase",    body: "my-band · critic: attached → detached" },
                    { t: "14:14:18", k: "message",  body: "my-band · tuner → ensemble" },
                    { t: "14:12:44", k: "recruit",  body: "backend-team · auth-eng recruited on box-02.lan" },
                    { t: "14:02:10", k: "ensemble", body: "my-band created via tempo-dev-team lineup" },
                  ].map((e, i) => (
                    <div key={i} className="event-row">
                      <span className="t">{e.t}</span>
                      <span className={`k ${e.k}`}>{e.k}</span>
                      <span>{e.body}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </main>
        <window.PhoneTabBar activeNav={activeNav} onNav={onNav} />
      </div>
    </div>
  );
}
window.Overview = Overview;

// ─── Player detail sheet (full-screen artboard showing the sheet open) ──────
function PlayerDetail() {
  const p = window.PLAYERS.find(x => x.id === "lead");
  return (
    <window.ModalShell label="modal · player detail · esc to close">
        <div className="sheet player-sheet">
          <div className="panel-head player-sheet-head">
            <div className="panel-head-title" style={{alignItems:"center"}}>
              <window.PlayerAvatar player={p} size={40} />
              <div className="col" style={{gap: 2}}>
                <div className="row">
                  <span className="subj display" style={{fontSize: 22}}>{p.name}</span>
                  <window.PhaseDot phase={p.phase} showLabel />
                </div>
                <div className="row">
                  <window.TypeBadge type={p.type} />
                  <span className="mono dim" style={{fontSize: 11}}>on {p.host} · {p.branch}</span>
                </div>
              </div>
            </div>
            <div className="row">
              <window.Btn variant="ghost" size="sm">@DM</window.Btn>
              <window.Btn variant="ghost" size="sm">Recall</window.Btn>
              <window.Btn variant="ghost" size="sm">Restart</window.Btn>
              <window.Btn variant="ghost" size="sm">Detach</window.Btn>
              <window.Btn variant="danger" size="sm">Destroy</window.Btn>
              <window.Btn variant="ghost" size="sm">✕</window.Btn>
            </div>
          </div>

          <div className="player-sheet-body">
            <div className="player-sheet-main">
              <window.SectionHead kicker="transcript" title="Recent messages" tight />
              <div className="col" style={{gap: 12}}>
                <FeedSnippet from="conductor" to="lead" t="14:03" body="start on attachment-math.ts — unify the lease-extension helper with the CAN-boundary path. Keep it pure; no Temporal imports." />
                <FeedSnippet from="lead" to="conductor" t="14:06" body="on it. will also fold in the 3× heartbeatMs negotiation from currentAttachment.leaseMs." outgoing />
                <FeedSnippet from="lead" to="ensemble" t="14:11" body="draft PR up — attachment-math.ts extracted, CAN boundary now uses currentAttachment.leaseMs. tests green locally." outgoing />
                <FeedSnippet from="lead" to="ensemble" t="14:22" body="PR #287 is up — needs a review when you have a moment. small: 4 files, +62/-48. tests pass." outgoing />
              </div>
            </div>

            <div className="player-sheet-side">
              <window.SectionHead kicker="attachment" title="Phase & lease" tight />
              <div>
                <window.KV k="phase"     v={<span><window.PhaseDot phase={p.phase} showLabel /></span>} mono={false} />
                <window.KV k="adapter"   v="claude-code · v1.2.4" />
                <window.KV k="host"      v={p.host} />
                <window.KV k="heartbeat" v={`${p.heartbeat} ago`} />
                <window.KV k="lease"     v="expires in 54s" />
                <window.KV k="run id"    v="a3f2·c881" />
              </div>

              <div style={{marginTop: 14}} />
              <window.SectionHead kicker="workdir" title="Work" tight />
              <div>
                <window.KV k="dir"      v={p.workDir} />
                <window.KV k="branch"   v={p.branch} />
                <window.KV k="worktree" v="yes" />
                <window.KV k="part"     v={p.part} mono={false} />
              </div>

              <div style={{marginTop: 14}} />
              <window.SectionHead kicker="traffic" title="Messages" tight />
              <div>
                <window.KV k="received" v={`${p.messages}`} />
                <window.KV k="sent"     v="44" />
                <window.KV k="outbox"   v="empty" />
              </div>
            </div>
          </div>
        </div>
    </window.ModalShell>
  );
}

function FeedSnippet({ from, to, t, body, outgoing }) {
  const player = window.PLAYERS.find(p => p.name === from) || { name: from, type: "tempo-soloist" };
  return (
    <div className="msg">
      <div className="msg-avatar">
        <window.PlayerAvatar player={player} size={26} />
      </div>
      <div>
        <div className="msg-head">
          <span className="sender" style={{ color: outgoing ? "var(--accent)" : `oklch(0.8 0.12 ${window.hueForType(player.type)})` }}>{from}</span>
          <span className="arrow">→</span>
          <span className="target">{to}</span>
          <span className="time">{t}</span>
        </div>
        <div className="msg-body">{body}</div>
      </div>
    </div>
  );
}
window.PlayerDetail = PlayerDetail;

// ─── Recruit wizard ─────────────────────────────────────────
function RecruitWizard() {
  return (
    <window.ModalShell label="modal · recruit a player · esc to close">
        <div className="dialog" style={{maxWidth: 720, width: "100%", boxShadow: "0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px var(--rule-strong)"}}>
              <div className="dialog-head">
                <div className="dialog-title">Recruit a player</div>
                <div className="steps">STEP 2 / 4</div>
              </div>
              <div className="dialog-body">
                <div className="field">
                  <label className="field-label">Name</label>
                  <input className="input" defaultValue="frontend-eng" />
                </div>
                <div className="field">
                  <label className="field-label">Type <span className="mono dim">· 9 available</span></label>
                  <div className="picker-list">
                    {window.PLAYER_TYPES.slice(0, 5).map((t, i) => (
                      <div key={t.name} className={`picker-row ${i === 0 ? "is-active" : ""}`}>
                        <span className="marker" />
                        <span className="col" style={{gap: 0}}>
                          <span className="name">{t.name}</span>
                          <span className="desc">{t.summary}</span>
                        </span>
                        <window.TypeBadge type={t.name} />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="field-grid-2">
                  <div className="field">
                    <label className="field-label">Work dir</label>
                    <input className="input" defaultValue="/repos/my-app" />
                  </div>
                  <div className="field">
                    <label className="field-label">Host</label>
                    <select className="select" defaultValue="studio.local">
                      {window.HOSTS.map(h => <option key={h.host}>{h.host}</option>)}
                    </select>
                  </div>
                </div>
                <div className="field">
                  <label className="field-label">Opening task <span className="mono dim">· optional</span></label>
                  <textarea className="textarea" defaultValue="Build out the dashboard routing for the new /loadouts page. Match the design system tokens." />
                </div>
                <div className="field">
                  <label className="field-label">Options</label>
                  <div className="chipset">
                    <span className="chip is-active">worktree</span>
                    <span className="chip">hold</span>
                    <span className="chip is-active">notify maestro</span>
                    <span className="chip">copilot bridge</span>
                  </div>
                </div>
              </div>
              <div className="dialog-foot">
                <span className="hint">↑↓ to select · Enter to confirm · Esc to cancel</span>
                <div className="row">
                  <window.Btn variant="ghost" size="md">Back</window.Btn>
                  <window.Btn variant="primary" size="md">Next: confirm</window.Btn>
                </div>
              </div>
        </div>
    </window.ModalShell>
  );
}
window.RecruitWizard = RecruitWizard;

// ─── Create Ensemble wizard ─────────────────────────────────
function CreateEnsemble() {
  return (
    <window.ModalShell label="modal · create ensemble · esc to close">
        <div className="dialog" style={{maxWidth: 720, width: "100%", boxShadow: "0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px var(--rule-strong)"}}>
              <div className="dialog-head">
                <div className="dialog-title">Create ensemble</div>
                <div className="steps">STEP 1 / 3 · lineup</div>
              </div>
              <div className="dialog-body">
                <div className="field">
                  <label className="field-label">Name</label>
                  <input className="input" defaultValue="frontend-squad" />
                </div>

                <div className="field">
                  <label className="field-label">Starting lineup</label>
                  <div className="picker-list" style={{maxHeight: 200, overflow: "auto"}}>
                    {window.LOADOUTS.map((l, i) => (
                      <div key={l.name} className={`picker-row ${i === 0 ? "is-active" : ""}`}>
                        <span className="marker" />
                        <span className="col" style={{gap: 0}}>
                          <span className="name">{l.name} <span className="mono dim" style={{fontWeight:400, fontSize:11}}>· {l.players} players</span></span>
                          <span className="desc">{l.summary}</span>
                        </span>
                        <span className="mono dim" style={{fontSize: 10}}>{l.shipped ? "SHIPPED" : "CUSTOM"}</span>
                      </div>
                    ))}
                    <div className="picker-row" style={{color:"var(--accent)"}}>
                      <span className="marker">+</span>
                      <span className="name">Blank ensemble (recruit manually)</span>
                      <span />
                    </div>
                  </div>
                </div>

                <div className="field-grid-2">
                  <div className="field">
                    <label className="field-label">Default host</label>
                    <select className="select"><option>studio.local</option></select>
                  </div>
                  <div className="field">
                    <label className="field-label">Start mode</label>
                    <div className="chipset">
                      <span className="chip is-active">hold</span>
                      <span className="chip">release immediately</span>
                    </div>
                  </div>
                </div>

                <div className="field">
                  <label className="field-label">Conductor instructions <span className="mono dim">· optional override</span></label>
                  <textarea className="textarea" rows="3" defaultValue="Coordinate the React dashboard rebuild. Gate phases; don't advance until the current phase is complete." />
                </div>
              </div>
              <div className="dialog-foot">
                <span className="hint">3 steps: lineup → customize → review</span>
                <div className="row">
                  <window.Btn variant="ghost" size="md">Cancel</window.Btn>
                  <window.Btn variant="primary" size="md">Next: customize players</window.Btn>
                </div>
              </div>
        </div>
    </window.ModalShell>
  );
}
window.CreateEnsemble = CreateEnsemble;

// ─── Loadouts library ───────────────────────────────────────
function Loadouts({ activeNav = "loadouts", onNav, activeEnsemble = "my-band", onSelectEnsemble, onOpenSwitcher } = {}) {
  return (
    <div className="artboard-body">
      <div className="app-shell">
        <window.Sidebar activeEnsemble={activeEnsemble} activeNav={activeNav} onNav={onNav} onSelectEnsemble={onSelectEnsemble} />
        <window.PhoneAppBar activeEnsemble={activeEnsemble} onMenu={onOpenSwitcher} />
        <main className="main">
          <header className="page-header">
            <div>
              <h1 className="page-title">Loadouts</h1>
              <div className="page-subtitle">Reusable ensemble lineups. Loaded via <span className="mono">claude-tempo up --lineup</span> or from here.</div>
            </div>
            <div className="page-actions">
              <window.Btn variant="ghost" size="sm" icon="↑">Import YAML</window.Btn>
              <window.Btn variant="primary" size="sm" icon="+">New loadout</window.Btn>
            </div>
          </header>
          <div className="page-pad scroll">
            <div className="panel">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Summary</th>
                    <th className="num">Players</th>
                    <th>Source</th>
                    <th>Last used</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {window.LOADOUTS.map((l, i) => (
                    <tr key={l.name} className={i === 0 ? "is-active" : ""}>
                      <td className="mono"><span className="accent">≡</span> {l.name}</td>
                      <td data-label="Summary" style={{color:"var(--text-2)", fontSize: 12.5, maxWidth: 320}}>{l.summary}</td>
                      <td data-label="Players" className="num">{l.players}</td>
                      <td data-label="Source"><span className="mono dim" style={{fontSize: 11}}>{l.shipped ? "shipped" : "custom"}</span></td>
                      <td data-label="Last used" className="mono dim" style={{fontSize: 11.5}}>{l.recent}</td>
                      <td style={{textAlign: "right"}}>
                        <window.Btn variant="ghost" size="sm">Edit</window.Btn>
                        <window.Btn variant="primary" size="sm" icon="▶">Load</window.Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </main>
        <window.PhoneTabBar activeNav={activeNav} onNav={onNav} />
      </div>
    </div>
  );
}
window.Loadouts = Loadouts;

// ─── Player types library ───────────────────────────────────
function PlayerTypes({ activeNav = "types", onNav, activeEnsemble = "my-band", onSelectEnsemble, onOpenSwitcher } = {}) {
  return (
    <div className="artboard-body">
      <div className="app-shell">
        <window.Sidebar activeEnsemble={activeEnsemble} activeNav={activeNav} onNav={onNav} onSelectEnsemble={onSelectEnsemble} />
        <window.PhoneAppBar activeEnsemble={activeEnsemble} onMenu={onOpenSwitcher} />
        <main className="main">
          <header className="page-header">
            <div>
              <h1 className="page-title">Player types</h1>
              <div className="page-subtitle">Agent definitions. <span className="mono">.md</span> with YAML frontmatter · three-tier lookup: project → user → shipped.</div>
            </div>
            <div className="page-actions">
              <window.Btn variant="ghost" size="sm" icon="⟳">Re-scan</window.Btn>
              <window.Btn variant="primary" size="sm" icon="+">New type</window.Btn>
            </div>
          </header>
          <div className="page-pad scroll types-grid">
            {window.PLAYER_TYPES.map(t => (
              <div key={t.name} className="panel" style={{padding: 16, gap: 10, display:"flex", flexDirection:"column"}}>
                <div className="row" style={{justifyContent:"space-between"}}>
                  <window.TypeBadge type={t.name} />
                  <span className="mono dim" style={{fontSize: 10.5}}>{t.shipped ? "SHIPPED" : "~/.claude/agents/"}</span>
                </div>
                <div className="display" style={{fontSize: 20}}>
                  <span style={{color: `oklch(0.82 0.12 ${window.hueForType(t.name)})`, fontFamily:"var(--ff-mono)", fontSize: 22, marginRight: 8}}>
                    {window.glyphFor(t.name)}
                  </span>
                  {t.name.replace("tempo-", "")}
                </div>
                <div style={{color: "var(--text-2)", fontSize: 13, lineHeight: 1.5}}>{t.summary}</div>
                <div className="row" style={{justifyContent: "space-between", marginTop: "auto"}}>
                  <span className="mono dim" style={{fontSize: 11}}>{t.tools} tools</span>
                  <div className="row">
                    <window.Btn variant="ghost" size="sm">Edit</window.Btn>
                    <window.Btn variant="ghost" size="sm">Duplicate</window.Btn>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </main>
        <window.PhoneTabBar activeNav={activeNav} onNav={onNav} />
      </div>
    </div>
  );
}
window.PlayerTypes = PlayerTypes;

// ─── Schedules ──────────────────────────────────────────────
function Schedules({ activeNav = "schedules", onNav, activeEnsemble = "my-band", onSelectEnsemble, onOpenSwitcher } = {}) {
  return (
    <div className="artboard-body">
      <div className="app-shell">
        <window.Sidebar activeEnsemble={activeEnsemble} activeNav={activeNav} onNav={onNav} onSelectEnsemble={onSelectEnsemble} />
        <window.PhoneAppBar activeEnsemble={activeEnsemble} onMenu={onOpenSwitcher} />
        <main className="main">
          <header className="page-header">
            <div>
              <h1 className="page-title">Schedules</h1>
              <div className="page-subtitle">Durable message deliveries via <span className="mono">claudeSchedulerWorkflow</span>.</div>
            </div>
            <div className="page-actions">
              <window.Btn variant="primary" size="sm" icon="+">New schedule</window.Btn>
            </div>
          </header>
          <div className="page-pad scroll">
            <div className="panel">
              <table className="table">
                <thead>
                  <tr><th>Name</th><th>Target</th><th>Cadence</th><th>Kind</th><th>Next fire</th><th></th></tr>
                </thead>
                <tbody>
                  {window.SCHEDULES.map((s, i) => (
                    <tr key={s.name} className={i === 0 ? "is-active" : ""}>
                      <td className="mono"><span className="accent">⧗</span> {s.name}</td>
                      <td data-label="Target"><span className="mono">{s.target}</span></td>
                      <td data-label="Cadence" className="mono" style={{color:"var(--text-2)"}}>{s.cadence}</td>
                      <td data-label="Kind"><span className="type-badge" style={{color: s.kind === "recurring" ? "var(--info)" : "var(--warn)", borderColor:"var(--rule-strong)", background:"transparent"}}>{s.kind}</span></td>
                      <td data-label="Next fire" className="mono" style={{color: "var(--accent)"}}>{s.next}</td>
                      <td style={{textAlign:"right"}}>
                        <window.Btn variant="ghost" size="sm">Edit</window.Btn>
                        <window.Btn variant="danger" size="sm">Cancel</window.Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </main>
        <window.PhoneTabBar activeNav={activeNav} onNav={onNav} />
      </div>
    </div>
  );
}
window.Schedules = Schedules;

// ─── Hosts ──────────────────────────────────────────────────
function Hosts({ activeNav = "hosts", onNav, activeEnsemble = "my-band", onSelectEnsemble, onOpenSwitcher } = {}) {
  return (
    <div className="artboard-body">
      <div className="app-shell">
        <window.Sidebar activeEnsemble={activeEnsemble} activeNav={activeNav} onNav={onNav} onSelectEnsemble={onSelectEnsemble} />
        <window.PhoneAppBar activeEnsemble={activeEnsemble} onMenu={onOpenSwitcher} />
        <main className="main">
          <header className="page-header">
            <div>
              <h1 className="page-title">Hosts</h1>
              <div className="page-subtitle">Daemons polling this Temporal namespace. Recruits with <span className="mono">host=</span> route to these task queues.</div>
            </div>
            <div className="page-actions">
              <window.Btn variant="ghost" size="sm" icon="⟳">Re-scan</window.Btn>
              <window.Btn variant="ghost" size="sm">Show stale</window.Btn>
            </div>
          </header>
          <div className="page-pad scroll">
            <div className="panel">
              <table className="table">
                <thead>
                  <tr><th>Host</th><th>Platform</th><th className="num">Sessions</th><th className="num">Player types</th><th>Daemon</th><th>Uptime</th><th>Heartbeat</th><th></th></tr>
                </thead>
                <tbody>
                  {window.HOSTS.map((h, i) => (
                    <tr key={h.host}>
                      <td className="mono"><span style={{color: h.status === "online" ? "var(--ok)" : "var(--warn)"}}>●</span> {h.host}</td>
                      <td data-label="Platform" className="mono" style={{color:"var(--text-2)"}}>{h.platform}</td>
                      <td data-label="Sessions" className="num">{h.sessions}</td>
                      <td data-label="Types" className="num">{h.playerTypes}</td>
                      <td data-label="Daemon" className="mono">{h.daemon}</td>
                      <td data-label="Uptime" className="mono dim">{h.uptime}</td>
                      <td data-label="Heartbeat" className="mono" style={{color: h.status === "online" ? "var(--text-2)" : "var(--warn)"}}>{h.heartbeat} ago</td>
                      <td style={{textAlign:"right"}}>
                        <window.Btn variant="ghost" size="sm">Logs</window.Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </main>
        <window.PhoneTabBar activeNav={activeNav} onNav={onNav} />
      </div>
    </div>
  );
}
window.Hosts = Hosts;

// ─── Settings ───────────────────────────────────────────────
function Settings({ activeNav = "settings", onNav, activeEnsemble = "my-band", onSelectEnsemble, onOpenSwitcher } = {}) {
  return (
    <div className="artboard-body">
      <div className="app-shell">
        <window.Sidebar activeEnsemble={activeEnsemble} activeNav={activeNav} onNav={onNav} onSelectEnsemble={onSelectEnsemble} />
        <window.PhoneAppBar activeEnsemble={activeEnsemble} onMenu={onOpenSwitcher} />
        <main className="main">
          <header className="page-header">
            <div>
              <h1 className="page-title">Settings</h1>
              <div className="page-subtitle">Maestro client preferences and Temporal connection.</div>
            </div>
          </header>
          <div className="page-pad scroll">
            <div className="settings-grid">
              <div className="panel settings-panel">
                <div className="panel-head">
                  <div className="panel-head-title">
                    <span className="h">Connection</span>
                    <span className="subj display">Temporal namespace</span>
                  </div>
                  <span className="page-pill"><span className="pill-dot" /> connected</span>
                </div>
                <div className="panel-body">
                  <window.KV k="namespace" v="default" mono />
                  <window.KV k="address" v="localhost:7233" mono />
                  <window.KV k="task queue" v="claude-tempo" mono />
                  <window.KV k="tls" v="off" mono />
                  <window.KV k="auth" v="—" mono />
                </div>
              </div>

              <div className="panel settings-panel">
                <div className="panel-head">
                  <div className="panel-head-title">
                    <span className="h">Profile</span>
                    <span className="subj display">Your maestro identity</span>
                  </div>
                </div>
                <div className="panel-body">
                  <window.KV k="display name" v="vinceblank" mono />
                  <window.KV k="email" v="vince@example.com" mono />
                  <window.KV k="default lineup" v="tempo-dev-team" mono />
                  <window.KV k="default host" v="studio.local" mono />
                </div>
              </div>

              <div className="panel settings-panel">
                <div className="panel-head">
                  <div className="panel-head-title">
                    <span className="h">Notifications</span>
                    <span className="subj display">When the maestro should ping you</span>
                  </div>
                </div>
                <div className="panel-body">
                  <window.KV k="player detached" v="banner" />
                  <window.KV k="conductor handoff" v="banner + sound" />
                  <window.KV k="schedule fired" v="silent" />
                  <window.KV k="recruit failed" v="banner" />
                </div>
              </div>

              <div className="panel settings-panel">
                <div className="panel-head">
                  <div className="panel-head-title">
                    <span className="h">Appearance</span>
                    <span className="subj display">Theme &amp; density</span>
                  </div>
                  <span className="mono dim" style={{fontSize: 10}}>see Tweaks ⌥T</span>
                </div>
                <div className="panel-body">
                  <window.KV k="theme" v="dark" />
                  <window.KV k="density" v="6 / 9" />
                  <window.KV k="accent" v="#E07A5F" mono />
                  <window.KV k="metronome" v="on" />
                </div>
              </div>

              <div className="panel settings-panel" style={{gridColumn: "1 / -1"}}>
                <div className="panel-head">
                  <div className="panel-head-title">
                    <span className="h">Danger zone</span>
                    <span className="subj display">Destructive actions</span>
                  </div>
                </div>
                <div className="panel-body">
                  <div className="settings-danger-row">
                    <div>
                      <div style={{fontWeight: 500}}>Disband all ensembles</div>
                      <div className="mono dim" style={{fontSize: 11}}>Stops all running players and clears outboxes. Sessions can be resumed later.</div>
                    </div>
                    <window.Btn variant="ghost" size="sm">Disband all</window.Btn>
                  </div>
                  <div className="settings-danger-row">
                    <div>
                      <div style={{fontWeight: 500}}>Reset client state</div>
                      <div className="mono dim" style={{fontSize: 11}}>Clears local preferences, recently-used loadouts, and chat drafts.</div>
                    </div>
                    <window.Btn variant="ghost" size="sm">Reset</window.Btn>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
        <window.PhoneTabBar activeNav={activeNav} onNav={onNav} />
      </div>
    </div>
  );
}
window.Settings = Settings;
