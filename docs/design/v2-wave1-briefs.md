# v2.0 Wave-1 Player Briefs + Fan-out

> **Author**: tempo-architect · 2026-06-20 · dispatch-ready briefs for the first 2.0 wave.
> Sequencing rationale in [`v2-execution-plan.md`](./v2-execution-plan.md). Removal census in
> [`v2-removal-census.md`](./v2-removal-census.md).

## Wave 1 — start immediately once D1 (1.7/1.8-stable shipped + #742 P0 parity) is confirmed

### Brief A — #786 cutover guard + protocol stamp + `up --from-upgrade` (CRITICAL PATH)
**Player:** senior engineer (tempo-soloist / my-tempo-engineer). **Why first:** keystone —
additive + reversible, and #787/#788 are hard-gated on it. **Surface:** workflows + daemon boot + CLI.

Four parts:
1. **Stamp** — every 2.0 session/maestro/scheduler workflow records `protocol: 2` on its START
   input + upserts memo `AgentTempoProtocol=2`. Must be on the start input so it's in history from
   run 1 and survives `continueAsNew`.
2. **Guard** — 2.0 daemon boot preflight (the `sa-preflight` slot, BEFORE worker registration)
   scans visibility for Running `agent-tempo` workflows lacking the stamp → **refuses to start
   workers**, prints the `agent-tempo upgrade-to-2` command. Loud-at-boot, never a silent replay fault.
3. **`up --from-upgrade`** — reads `~/.agent-tempo/upgrade-snapshot-v1.json` (the #785
   `snapshot-v1.ts` schema, already shipped) → recreates fresh protocol-2 workflows restoring
   lineups, #334 state slots, schedules, `sessionId`, non-default `model`.
4. **Cross-host** — add `protocolVersion` to the `claimAttachment` update (a 2.0-wire field);
   2.0 workflows reject v1 adapters with an actionable error.

**Files:** `workflows/session.ts|maestro.ts|scheduler.ts` (stamp), daemon boot / `cli/sa-preflight.ts`
(guard), `cli/commands.ts` (`up --from-upgrade`), `upgrade/snapshot-v1.ts` (reader), `claimAttachment`
signature. **Coordinate** the `protocolVersion`/`AgentTempoProtocol` wire additions with #788's v2 doc regen.
**Gotchas:** guard must run before workers start; reversible/additive — land it before any deletion.

### Brief B — #789 TUI deletion
**Player:** engineer (tempo-soloist) + docs (tempo-liner for README/docs surgery).
**GATE:** #742 P0 mission-control parity CLOSED first — confirm before starting. **Independent of the wire core.**

**Delete:** `src/tui/` (~9.3k LOC) · 21 TUI test files (incl. the 19 CI-quarantined Vitest failures —
deleted not fixed, per D3) · `docs/tui.md` + `docs/tui-performance.md` · `ink ×3`/`react`/`@types/react`
deps (drop `qrcode-terminal` ONLY after verifying the dashboard pairing-QR path doesn't share it).
**Repoint:** `cli.ts:755` — the lone external importer AND the bare-command default → replace per the
ratified §E.8/D2 ruling (bootstrap six-step + `status` + next-step hints, incl. a `command-center`
suggestion). **Add:** #288-style removed-verb hints for TUI launch verbs. `tui/removed-commands.ts`
dies here (also a #794 item — coordinate).
**Gotchas:** the bare-command default is the trap — don't leave bare `agent-tempo` dead.

### Brief C — #796 upgrade round-trip E2E scaffold
**Player:** QA (tempo-tuner / my-tempo-qa) + devops (tempo-roadie) for CI wiring. **Scaffold now;
passes at GA.** Building it now surfaces cutover gaps early and doubles as the cutover spec.

**Shape:** CI harness — `up` on 1.x-stable → `upgrade-to-2` (writes snapshot) → install 2.0 build →
`up --from-upgrade` → **assert continuity**: players recreated, lineups restored, #334 state slots
intact, schedules preserved, all workflows stamped protocol-2. Use dev-mode + mock adapters for a
hermetic, deterministic run. **Prereq:** full PASS needs #786 (`up --from-upgrade`); the harness + the
1.x-half build now. **Gotchas:** two version-pinned builds in CI; the continuity assertion set IS the
cutover contract — define it precisely.

## Wave 2 — fan out once #786's guard lands (pipeline behind wave 1)
- **#787 → #788 (Stream A)** — workflow clean-slate then wire-v2 regen; **sequential pair, single
  coordinated owner** (senior engineer); preceded by the half-day marker→wire map spike (census §A).
- **#794 (+#792 residual) (Stream C)** — delete the 11 shims + `CLAUDE_TEMPO_DEBUG`; engineer.
- **#793 (Stream D)** — tool-family merges via descriptor layer, shipped aliased; engineer.
- **#795 (Stream E, beta.2)** — SA auto-registration (local-only per D3); engineer.

## 8-player allocation
conductor (orchestrate) · architect (sequencing/reviews/marker-map spike) · eng-1 → #786 (critical
path) · eng-2 → A-stream prep (#787→#788) · eng-3 → #789 TUI delete · qa → #796 scaffold · devops →
1.7.0-stable cut + CI · docs → 1.8→1.7 naming reconciliation + #789 docs surgery.
