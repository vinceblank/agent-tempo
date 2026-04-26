// Shared data + helpers for the claude-tempo Maestro dashboard.
// Exposes everything on window so other Babel <script> files can consume.

const ACCENT = "#E07A5F";

// Deterministic musical glyph per player name
const GLYPHS = ["♩", "♪", "♫", "♬", "♭", "♮", "♯", "𝅘𝅥"];
function glyphFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return GLYPHS[h % GLYPHS.length];
}

// Deterministic hue per player type
const TYPE_HUES = {
  "tempo-conductor": 32,   // gold
  "tempo-composer":  210,  // steel blue
  "tempo-soloist":   18,   // terracotta-ish
  "tempo-tuner":     150,  // mint
  "tempo-critic":    340,  // rose
  "tempo-roadie":    260,  // violet
  "tempo-improv":    48,   // amber
  "tempo-liner":     190,  // teal
};
function hueForType(t) { return TYPE_HUES[t] ?? 200; }
function colorForType(t, alpha = 1) {
  return `oklch(0.72 0.11 ${hueForType(t)} / ${alpha})`;
}

// Phase → icon + color, borrowed verbatim from the TUI design system
const PHASES = {
  attached:   { icon: "●", label: "active",        color: "var(--ok)",   bucket: "active" },
  processing: { icon: "●", label: "processing",    color: "var(--ok)",   bucket: "active", pulse: true },
  awaiting:   { icon: "○", label: "idle",          color: "var(--text)", bucket: "idle" },
  draining:   { icon: "◐", label: "draining",      color: "var(--warn)", bucket: "disconnected" },
  detached:   { icon: "◐", label: "detached",      color: "var(--warn)", bucket: "disconnected" },
  booting:    { icon: "◔", label: "booting",       color: "var(--dim)",  bucket: "pending" },
  gone:       { icon: "✕", label: "gone",          color: "var(--dim)",  bucket: "gone" },
};

// ──────────────────────────────────────────────────────────────
// Fake ensemble data — a realistic SaaS dev team coordinating work
// ──────────────────────────────────────────────────────────────

const ENSEMBLES = [
  {
    id: "my-band",
    name: "my-band",
    description: "Primary: building the v0.27 release",
    players: 6,
    active: 4,
    tempo: 23, // msgs/min
    lineup: "tempo-dev-team",
    host: "studio.local",
    uptime: "2h 14m",
    current: true,
  },
  {
    id: "backend-team",
    name: "backend-team",
    description: "Auth service rewrite",
    players: 3,
    active: 2,
    tempo: 7,
    lineup: "tempo-review-squad",
    host: "studio.local",
    uptime: "38m",
  },
  {
    id: "release-crew",
    name: "release-crew",
    description: "v0.27 release prep & changelog",
    players: 4,
    active: 1,
    tempo: 2,
    lineup: "tempo-big-band",
    host: "box-02.lan",
    uptime: "6h 02m",
  },
  {
    id: "experiments",
    name: "experiments",
    description: "Exploratory — copilot bridge smoke tests",
    players: 0,
    active: 0,
    tempo: 0,
    lineup: "—",
    host: "—",
    uptime: "—",
  },
];

const PLAYERS = [
  {
    id: "conductor",
    name: "conductor",
    type: "tempo-conductor",
    phase: "processing",
    part: "coordinating frontend ↔ backend on the release",
    branch: "main",
    workDir: "/repos/claude-tempo",
    host: "studio.local",
    heartbeat: "2s",
    messages: 184,
    isConductor: true,
  },
  {
    id: "composer",
    name: "composer",
    type: "tempo-composer",
    phase: "awaiting",
    part: "waiting on tuner's test report",
    branch: "feat/v0.27",
    workDir: "/repos/claude-tempo",
    host: "studio.local",
    heartbeat: "14s",
    messages: 42,
  },
  {
    id: "lead",
    name: "lead",
    type: "tempo-soloist",
    phase: "processing",
    part: "refactoring the attachment state machine",
    branch: "feat/v0.27-lead",
    workDir: "/repos/claude-tempo",
    host: "studio.local",
    heartbeat: "1s",
    messages: 98,
    pulse: true,
  },
  {
    id: "eng",
    name: "eng",
    type: "tempo-soloist",
    phase: "processing",
    part: "implementing the hosts MCP tool",
    branch: "feat/v0.27-hosts",
    workDir: "/repos/claude-tempo",
    host: "box-02.lan",
    heartbeat: "3s",
    messages: 61,
    pulse: true,
  },
  {
    id: "tuner",
    name: "tuner",
    type: "tempo-tuner",
    phase: "processing",
    part: "running the v0.26 migration conformance suite",
    branch: "feat/v0.27-tests",
    workDir: "/repos/claude-tempo",
    host: "studio.local",
    heartbeat: "1s",
    messages: 33,
    pulse: true,
  },
  {
    id: "critic",
    name: "critic",
    type: "tempo-critic",
    phase: "detached",
    part: "reconnecting…",
    branch: "review/pr-284",
    workDir: "/repos/claude-tempo",
    host: "box-02.lan",
    heartbeat: "2m 14s",
    messages: 19,
  },
];

// Ensemble chat feed — conductor + player messages
const FEED = [
  { t: "14:02", from: "maestro",  to: "conductor", kind: "out",   body: "let's start on v0.27 — focus on the attachment state machine and the hosts tool" },
  { t: "14:02", from: "conductor", kind: "in",     body: "Acknowledged. I'll split this into two parallel tracks. lead takes the state machine, eng takes the hosts tool. tuner will run the conformance suite after each merge." },
  { t: "14:03", from: "conductor", to: "lead",     kind: "route", body: "start on attachment-math.ts — unify the lease-extension helper with the CAN-boundary path. Keep it pure; no Temporal imports." },
  { t: "14:03", from: "conductor", to: "eng",      kind: "route", body: "hosts MCP tool. Match the CLI formatter in src/utils/format-hosts.ts. Add --all for stale hosts (issue #274)." },
  { t: "14:11", from: "lead",      kind: "in",     body: "draft PR up — attachment-math.ts extracted, CAN boundary now uses currentAttachment.leaseMs. tests green locally." },
  { t: "14:12", from: "eng",       kind: "in",     body: "hosts tool scaffold compiles. pulling the hostProfile signal payload from the global maestro now." },
  { t: "14:14", from: "tuner",     kind: "in",     body: "conformance suite green on main. queuing a run against feat/v0.27-lead once it lands." },
  { t: "14:18", from: "maestro",   to: "conductor", kind: "out",   body: "how's critic doing? last I saw it was reviewing PR #284" },
  { t: "14:18", from: "conductor", kind: "in",     body: "critic's adapter detached ~2min ago — reconnect budget still has 13m. I'll hold reviews until it's back." },
  { t: "14:22", from: "lead",      kind: "in",     body: "PR #287 is up — needs a review when you have a moment. small: 4 files, +62/-48. tests pass." },
  { t: "14:23", from: "conductor", to: "critic",   kind: "route", body: "when you re-attach, start with PR #287 (attachment-math extraction)." },
];

// Events ring-buffer (maestro event log)
const EVENTS = [
  { t: "14:23:08", kind: "route",     body: "conductor → critic" },
  { t: "14:22:41", kind: "message",   body: "lead → ensemble" },
  { t: "14:18:22", kind: "phase",     body: "critic: attached → detached" },
  { t: "14:18:04", kind: "heartbeat", body: "critic: staleness warning" },
  { t: "14:14:18", kind: "message",   body: "tuner → ensemble" },
  { t: "14:12:09", kind: "message",   body: "eng → ensemble" },
  { t: "14:11:55", kind: "message",   body: "lead → ensemble" },
  { t: "14:03:12", kind: "route",     body: "conductor → eng" },
  { t: "14:03:02", kind: "route",     body: "conductor → lead" },
  { t: "14:02:44", kind: "recruit",   body: "conductor recruited" },
  { t: "14:02:10", kind: "ensemble",  body: "my-band created" },
];

const SCHEDULES = [
  { name: "status-check",   target: "all",        cadence: "every 20m",    next: "in 3m 12s",  kind: "recurring" },
  { name: "daily-digest",   target: "conductor",  cadence: "cron 09:00",   next: "in 18h 37m", kind: "recurring" },
  { name: "release-signoff", target: "conductor", cadence: "at 18:00",     next: "in 3h 37m",  kind: "one-shot" },
  { name: "tuner-sweep",    target: "tuner",      cadence: "every 1h",     next: "in 42m",     kind: "recurring" },
];

const HOSTS = [
  { host: "studio.local",  platform: "darwin · arm64",  playerTypes: 8, sessions: 4, daemon: "v0.26.3", uptime: "2d 14h", heartbeat: "1s", status: "online" },
  { host: "box-02.lan",    platform: "linux · x64",     playerTypes: 8, sessions: 2, daemon: "v0.26.3", uptime: "6d 03h", heartbeat: "3s", status: "online" },
  { host: "ci-runner-a",   platform: "linux · x64",     playerTypes: 6, sessions: 0, daemon: "v0.26.0", uptime: "3d 22h", heartbeat: "18s", status: "stale" },
  { host: "vm-build-03",   platform: "linux · x64",     playerTypes: 8, sessions: 0, daemon: "v0.26.3", uptime: "11h 09m", heartbeat: "2s", status: "online" },
];

const PLAYER_TYPES = [
  { name: "tempo-conductor", summary: "Orchestration hub. One per ensemble; receives reports and routes work.", tools: 24, shipped: true },
  { name: "tempo-composer",  summary: "Architect / planner. Designs the approach before implementation.", tools: 9,  shipped: true },
  { name: "tempo-soloist",   summary: "Single-focus engineer. Takes a discrete task and completes it.", tools: 11, shipped: true },
  { name: "tempo-tuner",     summary: "QA / performance. Writes tests, reports regressions.", tools: 10, shipped: true },
  { name: "tempo-critic",    summary: "Reviewer. Evaluates PRs and flags risks.", tools: 8,  shipped: true },
  { name: "tempo-roadie",    summary: "Build / infra. Handles tooling, CI, and releases.", tools: 12, shipped: true },
  { name: "tempo-improv",    summary: "Exploratory agent for spikes and ad-hoc work.", tools: 9,  shipped: true },
  { name: "tempo-liner",     summary: "Release notes / changelog writer.", tools: 6,  shipped: true },
  { name: "tempo-archivist", summary: "Custom: memory-only note-taker for post-mortems.", tools: 4,  shipped: false },
];

const LOADOUTS = [
  { name: "tempo-dev-team",     summary: "Conductor + composer + 2 soloists + tuner. The default dev lineup.", players: 5, shipped: true, recent: "45m ago" },
  { name: "tempo-review-squad", summary: "Conductor + critic + tuner. Review-only squad for PR sweeps.",      players: 3, shipped: true, recent: "2d ago" },
  { name: "tempo-big-band",     summary: "Everyone: conductor, composer, 3 soloists, tuner, critic, liner.",  players: 8, shipped: true, recent: "6h ago" },
  { name: "tempo-jam-session",  summary: "3 improvs + conductor. Exploratory spike sessions.",                 players: 4, shipped: true, recent: "—" },
  { name: "release-crew",       summary: "Custom: conductor + liner + 2 critics. Used for v0.27.",            players: 4, shipped: false, recent: "today" },
];

// Short tempo sparkline — 60 buckets of activity (messages per 30s)
const TEMPO_SERIES = [
  1,0,2,1,3,2,4,3,5,6,4,3,2,4,5,7,8,9,7,5,
  4,3,2,3,4,5,3,2,1,2,4,6,8,10,9,7,5,4,3,2,
  3,5,7,9,11,13,12,10,8,6,4,3,2,3,4,6,8,5,3,2,
];

Object.assign(window, {
  ACCENT, GLYPHS, glyphFor, TYPE_HUES, hueForType, colorForType, PHASES,
  ENSEMBLES, PLAYERS, FEED, EVENTS, SCHEDULES, HOSTS, PLAYER_TYPES, LOADOUTS, TEMPO_SERIES,
});
