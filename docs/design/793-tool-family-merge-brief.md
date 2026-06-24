# #793 — Tool-Family Merge: Eng-Ready Implementation Brief

> **Author**: tempo-architect · 2026-06-24 · beta.2's main feature.
> **Status**: eng-ready (implement once #795 SA-auto-registration check is done — per conductor sequencing).
> **Design source**: ratifies & operationalizes `docs/design/v2-beta1-checklist.md` §2 (#793 bullet).
> **Invariant (load-bearing)**: *alias-not-remove*. This change is **additive/non-breaking**. Add canonical
> tools; keep every old name as a forwarding alias. The moment anyone proposes *removing* an old name,
> #793 snaps back to a major-version gate. Alias drop is a **GA event** (D4), not beta.2.

---

## 0. TL;DR — what eng builds

Merge 5 tool families into canonical multi-action tools using a **flat `action` enum + per-action optional
fields, runtime-guarded** (NOT `z.discriminatedUnion`). Old per-action tool names stay registered as **thin
alias descriptors** that forward to the canonical handler with `action` hard-wired. Net surface change in
beta.2: **+3 net-new canonical tools** (`coat_check`, `state`, `gate`); `schedule` and `stage` canonicals
**reuse existing tool names**. Nothing removed. `evaluate_gate` stays separate (partial merge).

| Family | Canonical tool | Actions | Aliases (forward → action) | Canonical name is… |
|---|---|---|---|---|
| ① coat-check | `coat_check` | `put \| get \| list \| evict` | `coat_check_put`→put, `coat_check_get`→get, `coat_check_list`→list, `coat_check_evict`→evict | **net-new** (action required) |
| ② state | `state` | `save \| fetch \| clear` | `save_state`→save, `fetch_state`→fetch, `clear_state`→clear | **net-new** (action required) |
| ③ schedule | `schedule` | `create \| cancel \| list` | `unschedule`→cancel, `schedules`→list | **reused** (action defaults to `create`) |
| ④ stage | `stage` | `create \| list \| cancel` | `stages`→list, `cancel_stage`→cancel | **reused** (action defaults to `create`) |
| ⑤ gate (PARTIAL) | `gate` | `define \| list` | `quality_gate`→define, `gates`→list | **net-new** (action required) · `evaluate_gate` **untouched** |

**Stages reconcile (the flagged ×2-vs-3 question): RESOLVED → 3-action fold `stage {create|list|cancel}`.**
See §4 for the full rationale.

---

## 1. The two-rule pattern (applies to every family)

### Rule A — Canonical naming & the `action` default

- **Net-new canonical names** (`coat_check`, `state`, `gate`): `action` is a **required** enum. There is no
  legacy caller of these names, so we force explicitness.
- **Reused canonical names** (`schedule`, `stage`): the canonical tool reuses an existing tool name whose
  legacy semantic was the family's "create" action. To preserve backward-compat for callers that omit
  `action`, **`action` defaults to `'create'`**. Adding an *optional* `action` field to an existing schema
  is non-breaking (old callers omit it → `create`). This is the ONLY backward-compat subtlety.

### Rule B — Aliases keep their EXACT original param schema, no `action` field

Each old tool becomes a thin alias descriptor whose `params` are **byte-for-byte the original schema** (no
`action` field added) and whose handler forwards to the canonical handler with `action` injected:

```ts
// alias forwarder — trivial, preserves the legacy surface exactly
{
  name: 'coat_check_put',
  description: 'DEPRECATED — use `coat_check` with action="put". (forwarder)',
  params: COAT_CHECK_PUT_PARAMS,              // the original zod shape, unchanged
  handler: (args) => canonicalHandler({ ...args, action: 'put' }),
}
```

Result: every existing caller of `coat_check_put` sees an identical schema and identical behaviour. Zero
breakage. That is what makes deferring the alias-drop to GA costless.

---

## 2. Param-shape pattern (flat union, runtime-guarded)

**Decision (ratified): flat `{ action, ...per-action optional fields }`. NOT `z.discriminatedUnion`.**
MCP tool schemas flatten to a single JSON-Schema object; a zod discriminated union renders awkwardly for MCP
clients and complicates the alias forwarders. A flat object with an `action` enum + every other field optional,
validated at runtime, is cleaner and keeps forwarders trivial.

**I verified there are NO field-name *type* collisions across actions within any family** — every shared field
(`name`, `task`, `key`, `ticket`) has a consistent type across the actions that use it, so the union merges
cleanly. Shared fields become optional in the union and are runtime-required per action.

Canonical schema construction (coat_check shown; same shape for all):

```ts
const COAT_CHECK_CANONICAL_PARAMS = {
  action: z.enum(['put', 'get', 'list', 'evict']),   // required (net-new name)
  // put:
  summary:     z.string().min(1).max(COAT_CHECK_SUMMARY_MAX).optional(),
  content:     z.string().min(1).max(COAT_CHECK_CONTENT_MAX).optional(),
  contentType: z.string().max(COAT_CHECK_CONTENT_TYPE_MAX).optional(),
  ttlMs:       z.number().int().min(COAT_CHECK_TTL_MIN_MS).max(COAT_CHECK_TTL_MAX_MS).optional(),
  // get / evict:
  ticket:      z.string().regex(COAT_CHECK_TICKET_REGEX).max(COAT_CHECK_TICKET_MAX).optional(),
  // list:
  putBy:         z.string().max(PLAYER_NAME_MAX).optional(),
  prefix:        z.string().max(COAT_CHECK_SUMMARY_MAX).optional(),
  unfetchedOnly: z.boolean().optional(),
};
```

**Runtime guard** — the canonical handler validates per-action required fields before dispatch and throws a
friendly, actionable error on a missing field (do NOT rely on zod for cross-field requiredness; that's the
whole reason we avoid discriminatedUnion). Pattern:

```ts
function requireField<T>(v: T | undefined, action: string, field: string): T {
  if (v === undefined || v === null || v === '')
    throw new Error(`coat_check action="${action}" requires "${field}".`);
  return v;
}
```

**Handler dispatch** — extract each legacy handler's body into a shared internal fn (or keep the existing
factory's closure and switch on action). The canonical handler is a `switch (action)` that calls the same
per-action logic the legacy tools used, so behaviour is identical and the get-is-an-Update / list-is-a-Query
routing is preserved automatically (see §3 note).

```ts
handler: async (args) => {
  switch (args.action) {
    case 'put':   return doPut(args, deps);
    case 'get':   return doGet(args, deps);      // Workflow Update (mutates fetch counters)
    case 'list':  return doList(args, deps);     // read-only Query
    case 'evict': return doEvict(args, deps);
    default:      throw new Error(`Unknown coat_check action: ${String(args.action)}`);
  }
}
```

---

## 3. Per-family specification

All facts below verified against the v2 source (`src/tools/*.ts`). Existing handler bodies are **reused
verbatim** via the dispatch switch — no behavioural changes, only surface re-shaping.

### ① `coat_check` — net-new canonical, `action` required
- **put**: `summary`(req), `content`(req), `contentType`?, `ttlMs`? → ticket id + slot usage. *(Update; audit `putBy` from `getPlayerId()`)*
- **get**: `ticket`(req) → entry detail + content. *(**Update** — bumps `lastFetchedAt/By`, `fetchCount`)*
- **list**: `putBy`?, `prefix`?, `unfetchedOnly`? → headers only, no body. *(read-only Query; does NOT bump counters)*
- **evict**: `ticket`(req) → evict / no-op. *(Update; owner-or-conductor only; `evictedBy` from tool layer)*
- Factory deps today: `(client, config, getPlayerId)`. `list` factory has no `getPlayerId` — canonical keeps `getPlayerId` (only used by put/get/evict).
- **Registration block**: non-conductor (general) section.

### ② `state` — net-new canonical, `action` required
- **save**: `content`(req), `key`? (default `"main"`) → confirm. *(owner-only; through caller's session handle)*
- **fetch**: `key`?, `playerId`? (default self) → slot content or "(no state)". *(read self-or-peer; survives `destroy`)*
- **clear**: `key`? → cleared / already-empty. *(owner-only; idempotent)*
- Factory deps: union of today's — `(client, config, handle, getPlayerId)` (fetch needs client/config for peer reads; save/clear use handle).
- **Registration block**: non-conductor (general) section.

### ③ `schedule` — **reused** canonical name, `action` defaults to `create`
- **create** (default): `name`(req), `message`(req), `target`(req), one-of `at`/`delay`/`every`/`cron`, `timezone`?, `until`?, `count`?. *(legacy bare `schedule` behaviour — unchanged)*
- **cancel**: `name`(req) → removed / no-scheduler. *(was `unschedule`)*
- **list**: (no fields) → schedule listing. *(was `schedules`)*
- Factory deps: `(client, config, getPlayerId)`.
- **Aliases**: `unschedule`→cancel, `schedules`→list. **No alias for create** — the bare `schedule` *is* create.
- **Backward-compat note**: existing `schedule` callers pass no `action` → defaults to `create`. The rich
  one-of timing validation stays exactly as today, gated on `action === 'create'`.
- **Registration block**: non-conductor (general) section.

### ④ `stage` — **reused** canonical name, `action` defaults to `create` (see §4 reconcile)
- **create** (default): `name`(req), `players`(req, 1–10), `failurePolicy`? (`halt`|`continue`, default `halt`). *(legacy bare `stage` — unchanged; signals `setStage`)*
- **list**: (no fields) → stage status tree. *(was `stages`; reads stage query)*
- **cancel**: `name`(req) → cancelled. *(was `cancel_stage`; signals `cancelStage`)*
- Factory deps: `(handle, getPlayerId)`.
- **Aliases**: `stages`→list, `cancel_stage`→cancel. **No alias for create** — bare `stage` *is* create.
- **Registration block**: **conductor-only** (with the other gate/stage tools).

### ⑤ `gate` — net-new canonical, `action` required · **PARTIAL merge**
- **define**: `task`(req), `criteria`(req, 1–10) → gate set. *(was `quality_gate`; signals `setQualityGate`)*
- **list**: `task`?, `status`? (`open`|`passed`|`failed`) → gate tree. *(was `gates`)*
- **`evaluate_gate` STAYS A SEPARATE TOOL — do NOT fold it in.** Rationale: `evaluate_gate` is a distinct
  runtime *operation* (record pass/fail + notes against criteria, audit `evaluatedBy`), not a CRUD action on
  the gate *definition*. That semantic line — *define/list the gate* vs *act on the gate* — is the partial
  boundary. Same reasoning that keeps stage's create/list/cancel together (all definition CRUD) while gate's
  evaluate stands apart.
- Factory deps: `(handle, getPlayerId)`.
- **Aliases**: `quality_gate`→define, `gates`→list.
- **Registration block**: **conductor-only**. `evaluate_gate` remains its own conductor-only registration, unchanged.

---

## 4. Stages reconcile — the flagged ×2-vs-3 question (RESOLVED)

**Verdict: one canonical `stage` tool with THREE actions `create | list | cancel`.** The corpus's "×2→1"
note was an undercount, not a signal that one file is a runtime outlier.

Three files exist and all three are **CRUD peers on the same `StageEntry` entity**:
- `stage` (name `stage`) → **CREATE** a fan-out/fan-in tracker; signals `setStage`.
- `stages` (name `stages`) → **READ/LIST** stage status; reads the `stages` query.
- `cancel_stage` (name `cancel_stage`) → **DELETE/CANCEL**; signals `cancelStage`.

Why "×2" was written: `stage`(create) + `cancel_stage`(delete) are the two *write* peers, so they read as
"the two that obviously merge," with `stages`(read) mentally bucketed separately. But the read path is just
as much part of the same entity's CRUD, exactly like the established `worktree {create|remove|list}`
precedent (1 tool, 3 actions) already in the codebase.

**Why this is NOT the `evaluate_gate` situation**: none of the three stage operations is a runtime mutation
of in-flight state analogous to `evaluate_gate`. There is no "evaluate a stage" verb — stages auto-complete
when tracked players report. So there is no separate operation to carve out; the fold is a clean 3.

**Action verbs**: use `create | list | cancel` (mirrors `schedule`'s `create | cancel | list` verb set for
cross-family consistency; `create` as default preserves the legacy bare-`stage` behaviour).

---

## 5. Code structure & file plan

For each family, keep the existing per-action handler logic and add a canonical descriptor + alias forwarders.
Recommended shape per family (minimal churn, regex-drift-friendly — see §6):

- In the family's "home" file (e.g. extend `src/tools/coat-check-put.ts` or add `src/tools/coat-check.ts`),
  export:
  - `build<Family>Tool(deps): TempoToolDescriptor` — the **canonical** (action enum + switch handler).
  - `build<Family>AliasTools(deps): TempoToolDescriptor[]` — the **alias forwarders** as **explicit object
    literals** (not loop-generated — see §6 drift note).
- Extract each legacy handler body into a shared internal `do<Action>(args, deps)` so canonical + (if ever
  needed) alias both call one implementation. Legacy `build<OldTool>Tool` factories may be deleted once their
  body is extracted, OR kept and re-pointed; deleting reduces dup but touches more call-sites — eng's call,
  but the alias descriptor must exist either way.

**Central wiring** — `src/server-tools.ts`:
- `buildAllTempoTools(opts)` assembles the descriptor array; `registerAllTempoTools` renders via `renderToMcp`.
- General (non-conductor) families: push canonical + aliases for `coat_check`, `state`, `schedule`.
- Conductor-only block (gated on `opts.isConductor`): push canonical + aliases for `stage`, `gate`; keep
  `evaluate_gate` as-is.
- Both MCP entry points are covered automatically: `src/server.ts` (stdio) and the claude-api in-process MCP
  server both call `registerAllTempoTools` — no per-callsite duplication.

**Descriptor contract (unchanged)** — `src/tools/descriptor.ts`:
```ts
interface TempoToolDescriptor {
  name: string;
  description: string;
  params: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<TempoToolResult>; // { text, isError? }
}
```
`renderToMcp(server, descriptors)` registers each. No descriptor-layer changes required for #793.

---

## 6. Drift-check / SURFACE-REGISTRY / docs updates

### `docs/SURFACE-REGISTRY.md` (the drift source of truth)
- Add rows for the **3 net-new canonicals**: `coat_check`, `state`, `gate`.
- Keep **all** existing rows (canonical-reused `schedule`/`stage` already present; every old alias name stays).
- Mark alias rows' Description with the `DEPRECATED — use <canonical> action="<x>"` note so the registry
  reads as intent, not accident.

### `scripts/check-surface-drift.js`
- Today it regex-scrapes tool names from `src/tools/*.ts` via `/name:\s*'([^']+)',\s*description:/` and diffs
  against the registry table.
- **Constraint**: that regex only catches names that appear as `name: '...'` immediately followed by
  `description:` in source. **Therefore alias descriptors MUST be authored as explicit object literals**
  (each with literal `name:`/`description:` adjacent), not generated in a `.map()` loop — otherwise the drift
  check silently under-counts (a #707-class "scans nothing, reports clean" hazard).
- **Recommended hardening (do this)**: upgrade the drift check to enumerate the *actual* descriptor names from
  `buildAllTempoTools()` output rather than scraping source — more robust and immune to authoring style. Per
  the #707 lesson, also **assert a non-zero tool count** so a future enumeration breakage fails loud. If the
  import-based approach is too heavy for this PR, the literal-object rule above is the mandatory interim guard.

### `docs/WIRE-PROTOCOL.md`
- **No change.** #793 is a pure MCP-tool-surface refactor. Underlying signals/queries/updates
  (`setStage`, `cancelStage`, `stages` query, `setQualityGate`, `evaluateGateCriteria`, coat-check/state
  updates, scheduler signals) are **untouched**. Call this out in the PR body to preempt a drift-review flag.

### `docs/tools.md` + `docs/concepts.md`
- `docs/tools.md`: document each canonical tool with its `action` enum and per-action params; mark the old
  names as deprecated aliases. This is the user-facing reference.
- `docs/concepts.md`: light touch — note the merged tool names where families are described.

### Tests (BOTH dirs — `test/` mocha + `tests/` vitest)
- Add canonical-dispatch tests per family (each action routes correctly; runtime guard rejects missing
  per-action fields with the friendly error).
- Add **alias-parity tests**: calling `coat_check_put{...}` produces the same result as
  `coat_check{action:'put', ...}`. One per alias.
- Verify conductor-only gating still applies to `stage`/`gate` canonicals + aliases.
- `schedule`/`stage` backward-compat: a call with no `action` behaves as `create`.

---

## 7. Acceptance criteria (the done bar)

- [ ] 5 canonical tools registered: `coat_check`, `state`, `schedule`, `stage`, `gate` — each with the
      action enum in §0.
- [ ] All 13 alias tools (`coat_check_*`×4, `*_state`×3, `unschedule`, `schedules`, `stages`, `cancel_stage`,
      `quality_gate`, `gates`) registered as forwarders with **unchanged** param schemas + deprecated notes.
- [ ] `evaluate_gate` unchanged and still separate.
- [ ] `schedule` / `stage` callers omitting `action` still hit `create` (backward-compat).
- [ ] Per-action runtime guards throw friendly errors on missing required fields.
- [ ] `docs/SURFACE-REGISTRY.md` updated; `scripts/check-surface-drift.js` green (and hardened per §6).
- [ ] `docs/WIRE-PROTOCOL.md` NOT touched (confirm in PR body).
- [ ] Canonical-dispatch + alias-parity tests in both `test/` and `tests/`; `npm run check:all` green.
- [ ] No old tool name removed (alias-not-remove invariant holds).

## 8. Out of scope (explicitly)
- **Alias drop** → GA (D4). The single breaking step; where the ~8-net tool-count reduction actually lands.
- **Any wire-protocol / signal change** — none needed.
- **Folding `evaluate_gate`** — deliberately excluded (partial-merge boundary).
