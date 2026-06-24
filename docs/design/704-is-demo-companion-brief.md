# Companion spec — #704 interactive-gating (dev-channels dialog vs. the watchdog)

**Author:** tempo-researcher · **For:** @tempo-eng · **Status:** FINAL (architect re-ruled 2026-06-24 — §1 collapsed, IS_DEMO de-scoped)
**Companion to:** `docs/design/704-batch-fix-brief.md` (#704 booting watchdog) · **Refs:** #704, #18, #890

> **Filename note:** this file is historically named `…-is-demo-…`; IS_DEMO is now
> **out of scope** (see §4). The doc is the interactive-gating spec. Kept the path
> stable to avoid breaking cross-references.

## Why this exists

The #704 booting watchdog (`BOOTING_DEADLINE_MS`, default 180s) sweeps a session
that never reaches `claimAttachment`. The de-risk pass found it could sweep a
**legitimate** recruit: the interactive `claude-code` spawn passes
`--dangerously-load-development-channels server:agent-tempo` (`activities/outbox.ts:835`),
which shows a **blocking** dev-channels dialog. With the operator away — the exact
#704 autonomous scenario — nobody clicks, the session parks pre-attach, and the
watchdog false-kills it. **A false-kill of a real recruit is strictly worse than
the hang the watchdog fixes.** The resolution: **don't arm the watchdog for
interactive `claude-code` at all until #890 dissolves the dialog.** Headless
adapters never show the dialog and are armed immediately.

---

## Architect ruling (re-ruled 2026-06-24 — supersedes the detection-by-key draft)

The §PRE dig (below) broke the original "detect ANTHROPIC_API_KEY presence" idea.
The architect re-ruled:

- **Collapse the interactive gate.** ALL interactive `claude-code` is **disarmed
  (no booting watchdog) until #890**. No auth-mode detection — it was built on a
  false premise (§PRE).
- **`IS_DEMO` DROPS OUT OF SCOPE.** With interactive never armed, there is **no
  false-kill risk** → **no dialog bypass is needed** → the undocumented-env-var
  supply-chain risk is **eliminated**. The bypass + smoke-check + version-monitor
  machinery is all moot and removed.
- **Structural gating stands.** Gate on the adapter descriptor property
  `canBlockOnDialog`, not an `agentType` check: headless arm now / interactive
  disarm-until-#890.

### Architect's decomposition (the conceptual model — keep this)

- The dialog-**park** hang (recruit waiting on a human click) is **not a hang the
  watchdog should fix** — a watchdog there is the **WRONG tool**: it kills a
  session that's legitimately waiting for a human.
- **#890 (publish agent-tempo as an approved channel plugin → drop the
  `--dangerously-load-development-channels` flag → no dialog) is the RIGHT fix**
  for the dialog-park hang.
- A **post-#890 interactive watchdog** is still worthwhile — it catches the
  *non-dialog* interactive hangs (cold-launch wedge, crash-before-attach) once the
  dialog can no longer cause a false-positive. That's a follow-up, not part of
  this batch.

---

## §PRE — Precondition (RESOLVED by the de-risk dig)

**Original question:** is the dev-channels dialog OAuth-no-key-specific or
unconditional? **Resolved: effectively UNCONDITIONAL for agent-tempo's usage —
and key-presence cannot make it safe.** Findings (official Claude Code docs):

- **"API key authentication is explicitly unsupported for Channels"** — channels
  REQUIRE a claude.ai OAuth login. So setting `ANTHROPIC_API_KEY` does NOT silence
  the dialog; it makes agent-tempo's control channel **non-functional**. The
  "detect a key ⇒ safe" predicate is therefore invalid: with a key set, the
  session never attaches via our channel at all.
- The dev-channels dialog is documented as appearing **every launch**
  (unconditional), current through **v2.1.187**.
- The earlier OAuth-specific claim (internal `research_claude_code_prompts.md`,
  v2.1.92) had **no second source** and is most likely a misobservation (possibly
  conflated with `apiKeyHelper`).

**Residual caveat (does not change the decision):** the docs describe the
v2.1.80+ channels feature; there's a small chance agent-tempo's `server:` flag is
an older remote-control subsystem sharing the word "channels." The spawn's
`server:<name>` (dev) vs `plugin:<name>` (approved) syntax matches the channels
feature's family, so we treat the finding as applying. A live ±key spawn test
(human, @vinceblank) can confirm-later, but the **safe conclusion holds either
way**: disarm interactive until #890.

---

## §1 — Interactive `claude-code`: DISARMED until #890

There is **no detection predicate**. The booting watchdog does **not arm** for the
interactive `claude-code` adapter — interactive recruits keep today's
indefinite-`booting` behavior until #890 dissolves the dialog. Rationale: a
recruit parked on the dev-channels dialog is waiting on a human, and an
operator-away false-kill is worse than the hang. Document the disarm clearly so
it's a known, bounded gap (e.g. a one-time daemon log line: "interactive
claude-code: boot watchdog disarmed pending #890").

---

## §2 — Structural adapter gating (ratified)

Gate on a **structural adapter/spawn descriptor property** — `canBlockOnDialog`
(equivalently `interactive`) on the descriptor in `src/adapters/.../index.ts` (the
descriptor layer already exists per `adapters/index.ts`):

```
armWatchdog = !descriptor.canBlockOnDialog
//   headless adapters (canBlockOnDialog falsy) → ARM now
//   interactive claude-code (canBlockOnDialog true) → DISARM until #890
```

- **Arm headless NOW** — `claude-api`, `opencode`, `claude-code-headless`,
  `copilot`, `pi` set `canBlockOnDialog: false` (or omit). No dialog → safe.
- **Interactive `claude-code`** sets `canBlockOnDialog: true` → not armed.
- **Future interactive adapters inherit correct behavior** by setting the flag —
  no new hardcoded checks. The property is the contract, not the adapter name.
- Post-#890: flip interactive to armed (the dialog is gone) — a one-line change at
  the gate, no structural rework.

---

## §3 — (folded into §1)

The earlier "OAuth-no-key residual" is no longer a special case — the whole
interactive `claude-code` class is disarmed until #890 (§1). Nothing separate to
implement here.

---

## §4 — `IS_DEMO`: DE-SCOPED

`IS_DEMO` is **removed from #704 scope**. With interactive never armed there is no
false-kill to prevent, so no dialog bypass is needed. The undocumented-env-var
dependency, the smoke-check, and the `claude --version` window-monitor are **all
dropped** — eliminating the supply-chain risk rather than guarding it. The dialog
itself is dissolved properly by **#890** (the approved-channel-plugin path, which
also removes any need to track Claude Code's dialog behavior across versions).

> Net simplification: with no detection predicate and no IS_DEMO machinery, the
> "no pinned `claude` version" concern is also moot for #704 — it moves to #890,
> where the published plugin will carry its own Claude Code version floor.

---

## §5 — Strategic fix (the real resolution)

**#890** — publish agent-tempo as an **approved Claude Code channel plugin**,
which **dissolves the dev-channels dialog and retires
`--dangerously-load-development-channels`**. Feasibility scoped (issue #890): a
**self-serve** path exists (package as a plugin → community marketplace, or org
`allowedChannelPlugins` for enterprise) — LOW effort, not Anthropic-blocked. Once
it lands: flip interactive `claude-code` to armed (§2), drop the disarm log line
(§1), and `troubleshooting.md:267`'s limitation goes away.

---

## Test plan

- **§2 structural gate:**
  - every adapter descriptor with `canBlockOnDialog` falsy ARMS the watchdog
    (assert each headless adapter boots the booting deadline).
  - the interactive `claude-code` descriptor (`canBlockOnDialog: true`) does NOT
    arm — assert no booting deadline is scheduled for it.
  - future-adapter test: a new descriptor with `canBlockOnDialog: true` is gated
    OFF without any change to the watchdog code.
- **§1 disarm visibility:** an interactive `claude-code` recruit that never
  attaches is NOT swept and emits the documented "disarmed pending #890" log.
- **No regressions:** no key-detection code, no `IS_DEMO`, no version-monitor —
  assert none were added (the de-scope is real, not dormant).

## Sequencing
Land with the #704 watchdog batch (lockstep). The watchdog's `nextDeadlineMs()`
booting candidate (batch brief Item 1a) is **gated by `canBlockOnDialog`** so it
only arms for headless. Interactive arming is a deliberate post-#890 follow-up.
