// Shared visual primitives for the Maestro dashboard.
// Exposes components on window. Depends on React globals + shared.jsx.

const { useState, useEffect, useRef, useMemo } = React;

// ─── Metronome: swinging triangle + terracotta pendulum ────────
function Metronome({ size = 28, bpm = 92, running = true, standalone = false }) {
  // Pendulum swing driven by CSS animation; duration = 60/bpm
  const dur = 60 / Math.max(20, bpm);
  const animate = running && (window.__tweaks?.showMetronome !== false);
  const style = {
    "--bpm-dur": `${dur}s`,
    width: size,
    height: size,
  };
  return (
    <span className={`tempo-metronome ${animate ? "is-running" : ""} ${standalone ? "is-standalone" : ""}`} style={style} aria-label="metronome">
      <svg viewBox="0 0 64 64" width={size} height={size} fill="none">
        <path d="M32 8 L14 54 L50 54 Z" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
        <g className="pendulum">
          <line x1="32" y1="46" x2="32" y2="14" stroke="#E07A5F" strokeWidth="3" strokeLinecap="round" />
          <circle cx="32" cy="46" r="3" fill="#E07A5F" />
        </g>
      </svg>
    </span>
  );
}

// Full wordmark + metronome
function Brandmark({ size = "md" }) {
  const iconSize = size === "lg" ? 40 : size === "sm" ? 20 : 28;
  const fontSize = size === "lg" ? 26 : size === "sm" ? 13 : 17;
  return (
    <span className={`brandmark brandmark-${size}`}>
      <Metronome size={iconSize} />
      <span className="brandmark-word" style={{ fontSize }}>
        claude<span className="brandmark-dash">-</span>tempo
      </span>
    </span>
  );
}

// Phase dot — icon + optional label + pulse animation for active
function PhaseDot({ phase, showLabel = false }) {
  const spec = window.PHASES[phase] ?? window.PHASES.booting;
  return (
    <span className={`phase-dot ${spec.pulse ? "is-pulse" : ""}`} style={{ color: spec.color }}>
      <span className="phase-dot-icon">{spec.icon}</span>
      {showLabel && <span className="phase-dot-label">{spec.label}</span>}
    </span>
  );
}

// Player avatar — musical glyph on a tinted square, colored by role
function PlayerAvatar({ player, size = 32 }) {
  const isConductor = player.isConductor || player.type === "tempo-conductor" || player.name === "conductor";
  // Conductor gets a fixed warning-gold treatment + treble clef glyph,
  // overriding the per-type hue. It's the ensemble's required role and
  // should read as distinct from the rotating player roster.
  const hue = isConductor ? 75 : window.hueForType(player.type);
  const bg = isConductor ? `oklch(0.26 0.06 ${hue})` : `oklch(0.24 0.045 ${hue})`;
  const fg = isConductor ? `oklch(0.86 0.14 ${hue})` : `oklch(0.82 0.13 ${hue})`;
  const glyph = isConductor ? "𝄞" : window.glyphFor(player.name);
  return (
    <span
      className={"player-avatar" + (isConductor ? " is-conductor" : "")}
      style={{
        width: size,
        height: size,
        background: bg,
        color: fg,
        fontSize: size * (isConductor ? 0.72 : 0.55),
        borderColor: isConductor ? `oklch(0.55 0.13 ${hue})` : `oklch(0.35 0.05 ${hue})`,
        lineHeight: 1,
      }}
      aria-label={player.name}
    >
      {glyph}
    </span>
  );
}

// Type badge — tiny chip
function TypeBadge({ type }) {
  const hue = window.hueForType(type);
  return (
    <span
      className="type-badge"
      style={{
        color: `oklch(0.82 0.11 ${hue})`,
        borderColor: `oklch(0.38 0.07 ${hue})`,
        background: `oklch(0.2 0.035 ${hue} / 0.5)`,
      }}
    >
      {type}
    </span>
  );
}

// Tempo strip — sparkline of recent message activity, with beat bars
function TempoStrip({ series = window.TEMPO_SERIES, height = 44, bpm = 92 }) {
  const max = Math.max(...series, 1);
  const w = 4;
  const gap = 2;
  const total = series.length * (w + gap);
  return (
    <div className="tempo-strip" style={{ height }}>
      <div className="tempo-strip-label">
        <span className="mono dim">tempo</span>
        <span className="tempo-bpm">
          <span className="mono num">{bpm}</span>
          <span className="mono dim">bpm</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${total} ${height}`} width="100%" height={height} preserveAspectRatio="none" className="tempo-strip-svg">
        {/* beat grid */}
        {series.map((_, i) =>
          i % 10 === 0 ? (
            <line key={`g${i}`} x1={i * (w + gap)} x2={i * (w + gap)} y1={0} y2={height} stroke="var(--rule)" strokeDasharray="2 3" />
          ) : null
        )}
        {/* bars */}
        {series.map((v, i) => {
          const h = (v / max) * (height - 8);
          const x = i * (w + gap);
          const y = height - h - 2;
          const recent = i > series.length - 10;
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={w}
              height={Math.max(1.5, h)}
              rx={1}
              fill={recent ? "var(--accent)" : "var(--rule-strong)"}
              opacity={recent ? 1 : 0.75}
            />
          );
        })}
      </svg>
    </div>
  );
}

// Section header with roman-numeral accent
function SectionHead({ kicker, title, right, tight }) {
  return (
    <div className={`section-head ${tight ? "is-tight" : ""}`}>
      <div>
        {kicker && <div className="section-kicker mono">{kicker}</div>}
        <div className="section-title">{title}</div>
      </div>
      {right && <div className="section-head-right">{right}</div>}
    </div>
  );
}

// Key-value row
function KV({ k, v, mono = true }) {
  return (
    <div className="kv">
      <span className="kv-k mono">{k}</span>
      <span className={`kv-v ${mono ? "mono" : ""}`}>{v}</span>
    </div>
  );
}

// Generic button
function Btn({ children, variant = "default", size = "md", icon, onClick, disabled, title }) {
  return (
    <button
      type="button"
      className={`btn btn-${variant} btn-${size}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon && <span className="btn-icon">{icon}</span>}
      <span>{children}</span>
    </button>
  );
}

// Kbd
function Kbd({ children }) {
  return <kbd className="kbd">{children}</kbd>;
}

// Window chrome (traffic lights + title) for artboard mockups
function WindowChrome({ title, right, url }) {
  return (
    <div className="winchrome">
      <div className="winchrome-dots">
        <span className="winchrome-dot r" />
        <span className="winchrome-dot y" />
        <span className="winchrome-dot g" />
      </div>
      {url && <div className="winchrome-url mono">{url}</div>}
      {title && <div className="winchrome-title">{title}</div>}
      {right && <div className="winchrome-right">{right}</div>}
    </div>
  );
}

// ─── ModalShell ─────────────────────────────────────────────
// Consistent modal treatment for D/E (wizards) and B (player detail).
// Renders the live EnsembleWorkspace as a dimmed backdrop + scrim + a top
// label badge, with children centered in the viewport. Pass `width` to set
// sheet width (default 720); the child is expected to be the modal surface
// itself (.dialog or .sheet) — ModalShell only owns the chrome around it.
function ModalShell({ label, children, align = "center" }) {
  return (
    <div className="artboard-body" style={{ position: "relative" }}>
      {/* Live workspace as backdrop — desaturated + dimmed */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", filter: "saturate(0.6) brightness(0.55)" }}>
        <window.EnsembleWorkspace />
      </div>
      {/* Scrim */}
      <div style={{ position: "absolute", inset: 0, background: "rgba(8, 6, 5, 0.55)", backdropFilter: "blur(2px)" }} />
      {/* Label badge */}
      {label && (
        <div style={{ position: "absolute", top: 18, left: 0, right: 0, textAlign: "center", zIndex: 5, pointerEvents: "none" }}>
          <span className="mono" style={{ fontSize: 10.5, letterSpacing: "0.16em", color: "rgba(255,255,255,0.55)", textTransform: "uppercase", background: "rgba(0,0,0,0.45)", padding: "4px 10px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.1)" }}>
            {label}
          </span>
        </div>
      )}
      {/* Centered sheet container */}
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: align === "top" ? "flex-start" : "center", justifyContent: "center", zIndex: 4, padding: align === "top" ? "60px 24px 24px" : "60px 24px 24px" }}>
        {children}
      </div>
    </div>
  );
}

// ── Maestro mark — bare italic M (Fraunces) for the human operator ──
function MaestroMark({ size = 16, color = "var(--bone, #F5EBDD)", style = {} }) {
  return (
    <span
      className="maestro-mark"
      style={{
        fontFamily: '"Fraunces", serif',
        fontStyle: "italic",
        fontWeight: 500,
        fontSize: size,
        lineHeight: 1,
        color,
        display: "inline-block",
        letterSpacing: "-0.02em",
        ...style,
      }}
    >M</span>
  );
}

Object.assign(window, {
  Metronome, Brandmark, MaestroMark, PhaseDot, PlayerAvatar, TypeBadge, TempoStrip,
  SectionHead, KV, Btn, Kbd, WindowChrome, ModalShell,
});
