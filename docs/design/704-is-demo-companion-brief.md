# Companion spec — #704 interactive-gating (dev-channels dialog vs. the watchdog)

**Author:** tempo-researcher · **For:** @tempo-eng · **Status:** FINAL (architect-ratified 2026-06-24)
**Companion to:** `docs/design/704-batch-fix-brief.md` (#704 booting watchdog) · **Refs:** #704, #18, #890

## Why this exists

The #704 booting watchdog (`BOOTING_DEADLINE_MS`, default 180s) sweeps a session
that never reaches `claimAttachment`. The de-risk pass found a way it could sweep
a **legitimate** recruit: the interactive `claude-code` spawn passes
`--dangerously-load-development-channels` (`activities/outbox.ts:835`), which can
show a **blocking** dev-channels dialog. With the operator away — the exact #704
autonomous scenario — nobody clicks, the session parks pre-attach, and the
watchdog false-kills it. **A false-kill of a real recruit is strictly worse than
the hang the watchdog fixes**, so arming the watchdog for interactive
`claude-code` is gated by everything below. Headless adapters never show the
dialog and are unaffected.

---

## Architect ruling (ratified — supersedes the earlier IS_DEMO-default draft)

The ruling **decouples the safety win from the IS_DEMO risk**:

- **`IS_DEMO` REJECTED as the default.** It's undocumented with unverifiable
  side-effects — "demo mode" could silently alter **billing attribution / model /
  telemetry**, which would break the subscription-billing value-prop of the OAuth
  `claude-code` adapter (the exact property a Max/Pro user chose). Version-fragile.
- **Detection, not injection.** Arm interactive `claude-code` when the spawn env
  **already** carries `ANTHROPIC_API_KEY` (key auth ⇒ no dialog ⇒ safe). Do **NOT**
  force-inject a key — that re-routes billing off the subscription.
- **OAuth-no-key residual stays DISARMED** pending the strategic channel-plugin
  fix (hang is bad; operator-away false-kill is worse).
- **Adapter-gating RATIFIED, structural.** Gate on a structural adapter/spawn
  descriptor property, **not** a hardcoded `agentType` check.
- **`IS_DEMO` only as a guarded, time-boxed stopgap** if eng deems the narrow
  OAuth-no-key case urgent — never the default.

---

## §PRE — Precondition eng MUST confirm FIRST (gates the whole shape)

**Is the dev-channels dialog OAuth-no-key-SPECIFIC, or UNCONDITIONAL?** Two
in-repo sources disagree, and which is true changes the entire interactive-gating
design:

| Source | Says |
|---|---|
| `docs/troubleshooting.md:267` | **Unconditional** — "Claude Code shows a confirmation prompt that must be manually acknowledged" (no auth qualifier). |
| memory `research_claude_code_prompts.md` (v2.1.92 de-risk) | **OAuth-specific** — "Dialog only shows when OAuth tokens are present; with `ANTHROPIC_API_KEY` set, dev channels load silently." |

**Decision tree:**
- **If OAuth-specific (researcher's lean — the note names the version + mechanism;
  treat troubleshooting.md:267 as imprecise/stale, and FIX it as part of this
  work):** §1 detection-by-key-presence is valid → arm interactive `claude-code`
  whenever `ANTHROPIC_API_KEY` is present; only OAuth-no-key stays disarmed (§3).
- **If UNCONDITIONAL:** key presence does NOT make it safe → §1 collapses; the
  watchdog must stay **disarmed for ALL interactive `claude-code`** until the
  strategic fix (§5), and `IS_DEMO` (§4) becomes the only pre-strategic lever.

**Action:** make this the **first item in eng's checklist** — confirm empirically
(spawn interactive `claude-code` once under OAuth-no-key, once under
`ANTHROPIC_API_KEY`, observe the dialog) before implementing §1–§4, and reconcile
`troubleshooting.md:267` to the verified truth.

---

## §1 — Detection-not-injection (the clean default; valid iff §PRE = OAuth-specific)

Arm the interactive `claude-code` watchdog **only when `ANTHROPIC_API_KEY` is
already present in the spawn env** — key auth loads dev channels silently, so the
session attaches within the deadline.

- The check is on the env the daemon will pass to `spawnInTerminal`
  (`activities/outbox.ts:841-847`): `const dialogSafe = !!process.env.ANTHROPIC_API_KEY`
  (resolve against the same env that reaches the spawn, not just the activity's).
- **Do NOT add `ANTHROPIC_API_KEY` to `envVars` yourself** (architect: forced
  injection re-routes billing off the subscription — the OAuth adapter's whole
  point). Detect-only.
- Pass `dialogSafe` (or the structural flag from §2 combined with it) to the
  session so the watchdog knows whether arming interactive is safe.

---

## §2 — Structural adapter gating (ratified refinement)

Do **not** gate on `agentType === 'claude'`/`'claude-code'`. Add a **structural
property to the adapter/spawn descriptor** — e.g. `interactive: true` /
`canBlockOnDialog: true` on the descriptor in `src/adapters/.../index.ts` (the
descriptor layer already exists per `adapters/index.ts`). The watchdog arms by:

```
armWatchdog =
  !descriptor.canBlockOnDialog            // headless adapters → always arm
  || dialogSafe                           // interactive + ANTHROPIC_API_KEY present (§1)
  // else: interactive OAuth-no-key → DISARMED (§3)
```

- **Arm headless NOW** — every non-interactive adapter (`claude-api`, `opencode`,
  `claude-code-headless`, `copilot`, `pi`) sets `canBlockOnDialog: false` (or omits
  it). No dialog possible → unconditionally safe.
- **Future interactive adapters inherit correct behavior** by setting the flag —
  no new hardcoded checks. This is the architect's refinement: the property is the
  contract, not the adapter name.

---

## §3 — OAuth-no-key residual: leave DISARMED

For interactive `claude-code` under OAuth login with **no** `ANTHROPIC_API_KEY`
(the #704 incident population), **leave the watchdog disarmed** — i.e. today's
indefinite-`booting` behavior — until the strategic channel-plugin fix (§5)
dissolves the dialog. Rationale (architect): an indefinite hang is bad, but an
operator-away false-kill of a legitimately-launching recruit is worse, and this
is exactly the population that can't click. Document the residual clearly so it's
a known, bounded gap, not a silent one (e.g. a one-time daemon log line:
"interactive claude-code under OAuth-no-key: boot watchdog disarmed pending
#890").

---

## §4 — `IS_DEMO` as a guarded, time-boxed stopgap (NOT the default)

Only if eng judges the OAuth-no-key case urgent before §5 lands. If used, it MUST
be:

1. **Safe-default-DISARMED** — off unless explicitly enabled.
2. **Behind a LOUD smoke-check** — spawn interactive `claude-code` under
   OAuth-no-key and **assert attach-within-deadline**; if the assert fails (a
   Claude Code update broke `IS_DEMO`, or it now alters billing/model/telemetry),
   fail LOUD and auto-revert to §3 disarmed. Never silent.
3. **Version-pinned + monitored** — pin the verified `claude --version` range;
   preflight warns/fails outside it.
4. **Scoped to the interactive spawn env only** — never daemon-wide.

The billing/telemetry side-effect risk is the reason this is a stopgap, not the
default — call it out in any log/flag describing the mode.

---

## §5 — Strategic fix (the real resolution)

The conductor is filing **#890** — publish agent-tempo as
an **approved Claude Code channel plugin**, which **dissolves the dev-channels
dialog entirely and retires the `--dangerously-load-development-channels` flag**.
Once that lands, §1–§4 and the whole interactive-gating apparatus collapse to
"arm the watchdog unconditionally" and `troubleshooting.md:267`'s limitation goes
away. Reference it from this brief and from the #704 batch brief's dependency
section.

---

## Test plan

- **§PRE:** documented empirical result (OAuth-no-key vs key-present dialog
  behavior) recorded in the PR; `troubleshooting.md:267` reconciled to it.
- **§1 detection:** with `ANTHROPIC_API_KEY` present, interactive `claude-code`
  watchdog ARMS; with it absent (OAuth-no-key), it stays DISARMED. No key is ever
  injected into the spawn env by agent-tempo (assert `envVars` unchanged).
- **§2 structural gate:** every adapter descriptor with `canBlockOnDialog` falsy
  arms immediately; the interactive descriptor arms only when `dialogSafe`. Add a
  future-adapter test: a new descriptor with `canBlockOnDialog: true` is gated
  without any code change to the watchdog.
- **§3 residual:** OAuth-no-key interactive session is NOT swept (watchdog
  disarmed) and emits the documented "disarmed pending #890" log.
- **§4 stopgap (if implemented):** smoke-check failure path auto-reverts to
  disarmed and logs loud; disabled by default.

## Sequencing
Land with the #704 watchdog batch (lockstep). Order: §PRE confirmation → §2
structural descriptor flag → §1 detection → §3 residual logging → (§4 only if
urgent). The watchdog's interactive arming cannot ship ahead of §PRE+§1+§2.
