# Full protobuf payload migration

> **Status**: Design proposal (spike — no implementation in this branch)
> **Author**: tempo-architect
> **Branch**: `design/319-protobuf-migration`
> **Tracking**: issue #319 (approved for autonomous pickup)
> **Audience**: implementing engineer (when scheduled, post-#318), conductor for review.

---

## 0. TL;DR

vinceblank approved this; sequencing is post-#318 implementation per the issue. This spike grounds the 8 open design decisions and validates the project's three load-bearing risks (cost-justification, determinism audit feasibility, rollback) before the implementer picks it up.

**Recommendation: PROCEED with explicit gates**, not a blank-cheque "do it." All three risks are answerable:

1. **Is the JSON pain real today?** Modest. Concrete wins: schema-as-source-of-truth + single-encoding story. Speculative wins: cross-language SDK, wire-size savings. The pain alone wouldn't justify a 2-week migration; the **schema-evolution discipline** the proto3 contract enforces is the true value at our scale.
2. **Is the determinism audit tractable?** Yes. Of 74 `??` sites across `src/workflows/`, **~10-15 are at semantic risk** under proto3 zero-defaults. Well within the threshold I committed to surface back at (>50 = block).
3. **Is the rollback story real?** Yes for PR-1, partially for PR-2, **no for PR-3 post-cutover**. Mitigation: gate PR-3 on a 24-hour staging-soak. Pre-cutover rollback is cheap; post-cutover requires republish + destroy-and-restart all running ensembles.

**Locked decisions** (§3-§9): ts-proto / `protos/` at repo root / field numbers + reserved ranges from day 1 / decode helper in PR-1 (not deferred) / v1.0.0 cutover / fail-closed on pre-protobuf workflows / Option B refactor (TS-interface-compatible) / determinism audit playbook in §10.

**Estimated cost**: matches issue #319 — ~2 weeks dedicated workstream, 1-2 engineers. PR-1 ~3-4 days, PR-2 ~5-7 days, PR-3 ~1 day.

---

## 1. The three honest questions (load-bearing analysis)

The conductor's dispatch flagged this design as economically/risk-different from prior spikes. These three questions get evidence-grounded answers before the implementer takes the work.

### 1.1 Is the JSON pain real today?

| Claimed JSON pain | Real today? | Evidence |
|---|---|---|
| Wire size | **No** | At dozens-of-RPCs/sec scale, payload size doesn't move latency budgets. Issue #319 itself rates this "Modest." |
| Schema-as-source-of-truth | **Partial** | TS interfaces in `src/types.ts` ARE the contract today, but they're erasable at runtime. A sender can ship malformed payloads and a receiver only catches it via Zod (which we use selectively at MCP-tool boundaries, not at every workflow signal). Real but not blocking. |
| Single-encoding story | **Modest** | Today's encoding is uniform JSON. The "what encoding is this?" branching the issue claims doesn't exist yet. Avoiding *future* bifurcation is the win, not solving present pain. |
| Cross-language SDK | **Speculative** | No current non-TS consumer. Foundation for future Python/Go workers — value is real but unrealized. |
| Schema-evolution discipline | **Real, undocumented** | This is the under-articulated win. Proto3 forces field-number reservations, optional-vs-default semantics, deprecation conventions — all things TS interfaces let us be lazy about. Today's `recall` extension (#128) and `attachmentTicket` extension (#318) are clean because reviewers are vigilant; protobuf would make them *typecheckable*. |

**Verdict**: **modest concrete pain, real schema-discipline win**. The cost-benefit math leans toward proceeding **specifically because** vinceblank already accepted the cost ceiling (2-week investment, breaking change, no backward compat) and pre-1.0 is the cheapest moment to take the discipline.

### 1.2 Is the determinism audit tractable?

I committed to surfacing back if the at-risk site count exceeded 50. Grounded in actual code:

| Pattern | Total occurrences | At risk under proto3 |
|---|---|---|
| `?? <value>` (any) | 74 | — |
| `?? <number>` (e.g. `?? 0`, `?? DEFAULT_MS`) | ~25 | **0** — proto3 number default is `0`; `0 ?? x` returns `0` in both encodings. Same behavior. |
| `?? <bool>` (e.g. `?? false`) | ~5 | **0** — proto3 bool default is `false`; same behavior. |
| `?? []` / `?? {}` (collections) | ~30 | **0** — proto3 repeated/map default is empty; same behavior. |
| `?? null` | ~5 | **Possibly 1-2** — depends whether the field uses proto3 `optional` (preserves undefined) or default (returns `""` for string). Audit per site. |
| `?? '<string>'` (string fall-through) | ~12 | **~7-11** — proto3 string default is `""`; `?? '<value>'` does NOT trigger on `""`. Each must be re-examined for "is `""` semantically distinct from absence?" |

Concrete at-risk sites identified by direct grep:

| File | Line | Pattern | Risk class |
|---|---|---|---|
| `session.ts` | 201 | `input.phase ?? 'booting'` | High — phase enum string |
| `session.ts` | 206 | `input.part ?? input.autoSummary ?? 'No description set'` | High — both fall-throughs are strings |
| `session.ts` | 600, 779, 833, 1289 | `(input.metadata.agentType ?? 'claude')` | High — agentType enum string (4 sites) |
| `maestro.ts` | 374, 404 | `result.error ?? 'Failed to ...'` | Medium — activity-result error field |
| `session.ts` | 474, 507 | `currentAttachment?.attachmentId ?? 'none'` | **Safe** — optional-chain handles undefined first |
| `session.ts` | 1303 | `lastDetachReason = lastDetachReason ?? 'force'` | **Safe** — local variable, not crossing workflow boundary |

**Total at-risk**: 7 sites with high risk, 2 with medium. **9 mandatory audit + fix targets.** Well under my 50-threshold.

**Mitigation pattern**: each at-risk site converts from `?? '<default>'` to one of:
- `field !== undefined ? field : '<default>'` — explicit-presence check (works on both encodings; mark proto field as `optional`)
- `field || '<default>'` — falsy-fallback (works for "" and undefined; matches the existing semantics for these specific sites because `''` and `undefined` are both "absent")
- Set the proto3 field with explicit `optional` keyword so ts-proto generates `field?: string` and `??` retains JSON-like semantics

The implementer codifies this in PR-2's audit checklist (§10) — every `?? '<string>'` site gets reviewed before the converter switch.

**Verdict**: **tractable**. ~9 mandatory fixes, mechanical, testable.

### 1.3 Is the rollback story real?

Per-PR rollback cost matrix:

| PR | What ships | Rollback cost | Operator action needed? |
|---|---|---|---|
| **PR-1** | `.proto` files, `ts-proto` build step, generated types in `dist-protos/`, decode helper CLI. **Workflow code still uses JSON**; converter NOT switched. | **Free** — `git revert` the PR. No deployed wire change; no in-flight workflow impact. | No |
| **PR-2** | Workflow + activity code refactored to use generated TS types; tests updated. **Converter still NOT switched** — wire format remains JSON. | **Cheap** — `git revert` reverses the type-import swap and the determinism audit fixes. ~2-3 hours of mechanical un-doing if the audit fixes have downstream effects. No in-flight workflow impact. | No |
| **PR-3** | `payloadConverterPath` set on `Client`, `Worker`, `TestWorkflowEnvironment`. Wire format flips to protobuf. Major version bump shipped. | **Painful** — republish previous npm tag, redeploy all daemons, destroy-and-restart every running ensemble, operators on every host re-run `claude-tempo down --destroy && up`. **Hours of operator-coordinated effort**, can't be done by one person. | Yes — every operator |

**The PR-3 cost is the load-bearing risk.** Mitigation:

1. **Soak gate**: PR-3 ships to a staging environment first; runs ≥ 24 hours under realistic load; only then to npm latest tag. The 24h is calibrated against the maestro CAN cycle (every ~12 hours under normal load) so we observe at least one CAN through the new converter.
2. **Pre-cutover smoke checklist**: PR-3's PR description includes a 10-item operator checklist (destroy old workflows, confirm version, validate decode helper, etc.). Pre-flight rather than post-flight discovery.
3. **Decode helper required** (§6): operators MUST be able to inspect any in-flight payload during the soak. Without `claude-tempo decode`, post-cutover debugging is opaque-base64-vs-stack-trace.
4. **Communicate the cutover**: PR-3's CHANGELOG entry and release notes explicitly call out the breaking change with operator migration steps.

**Verdict**: rollback is **real and asymmetric**. Pre-cutover free; post-cutover painful. The soak + smoke checklist + decode helper bring the risk to acceptable. **Vetoes are still possible up to and during PR-3** — no irreversibility before the npm publish.

---

## 2. Wire-protocol surface inventory

Issue #319 claims "100+ message types." Verified count from current code:

| Source | Count |
|---|---|
| `src/workflows/signals.ts` exports (signals + queries + updates) | 44 |
| `src/workflows/maestro-signals.ts` exports | 18 |
| `src/workflows/scheduler-signals.ts` exports | 6 |
| **Wire-protocol named contracts** | **68** |
| `src/types.ts` outbox-entry types (CueOutboxEntry, RecruitOutboxEntry, ReportOutboxEntry, etc.) | ~10 |
| Activity input/output types (in `src/activities/outbox.ts`, `maestro.ts`, `hard-terminate.ts`, `schedule-fire.ts`) | ~25 |
| Workflow input/output types (`SessionInput`, `MaestroInput`, `GlobalMaestroInput`, `SchedulerInput`) | 4 |
| Sub-types referenced by the above (`AttachmentPhase`, `Message`, `OutboxEntry`, `Attachment`, `HostProfile`, `EnsembleChatMessage`, etc.) | ~30+ |
| **Total .proto messages to author** | **~135** |

The 100+ claim is conservative — actual count is closer to 130-140 message types. **Not a blocker** — boilerplate scales linearly and ts-proto generates the TS bindings automatically. PR-1's effort estimate (3-4 days) holds.

`docs/WIRE-PROTOCOL.md` has 153 table rows; not all are message types (some are search-attribute names, type-reference rows). Cross-checked: actual signal/query/update name count matches the 68 export count.

---

## 3. Tooling choice — `ts-proto` selected

| Tool | Output shape | Build complexity | Verdict |
|---|---|---|---|
| **`ts-proto`** | Plain TS interfaces (`outputClientImpl=false, useExactTypes=true`) — closest to existing `src/types.ts` patterns | Single binary `protoc` + `ts-proto` plugin | **Selected** |
| `protoc-gen-ts` | Class wrappers with `.create()`, `.encode()`, `.decode()` methods — heavier refactor | Same | Rejected — class wrappers ripple through every site that constructs a payload |
| Hand-written `.proto` + `protobufjs` runtime parsing | No code-gen; all runtime introspection | No build step but runtime overhead + no static types | Rejected — gives up the schema-as-types win |

**ts-proto v2.11.6** (current at 2026-04-26) supports proto3 `optional` keyword (preserves field presence semantics for `string`/`number`/`bool`); generates `field?: T` for those, matching the existing `src/types.ts` `field?:` convention. Also supports `useExactTypes=true` for `as const` discriminated unions (matches our existing `OutboxEntry` union shape).

`@temporalio/common` already exports `DefaultPayloadConverterWithProtobufs` + `ProtobufBinaryPayloadConverter` — the converter primitives are in-place; no need to author them.

**Generated-output strategy**: `ts-proto` writes generated TS into `src/protos/` (committed to source). Reasoning vs `dist-protos/`:
- `src/protos/` is importable directly from workflow code with normal relative imports
- IDE / TS-server picks up changes immediately (no build-roundtrip)
- Generated files are in source control = reviewable in PRs (drift between `.proto` and TS is visible at review time)
- Trade-off: PR diffs show generated code; mitigated by `--no-verify-meta` style commit hygiene

`workflow-bundle.js` already wraps `src/workflows/`; generated `src/protos/` types are imported normally and bundle by reference.

---

## 4. Repository layout

```
protos/                    # Source of truth for wire shapes (NEW)
├── README.md              # Authoring conventions, field-number reservations log
├── session.proto          # Session signals, queries, updates, input/output
├── scheduler.proto        # Scheduler messages
├── maestro.proto          # Per-ensemble + global maestro messages
├── outbox.proto           # OutboxEntry union variants
├── activity.proto         # Activity input/output messages
├── shared.proto           # Cross-cutting types (Message, Attachment, AttachmentPhase, HostProfile, ...)
└── tools/                 # MCP tool argument shapes (used by sender-side validation)
    ├── cue.proto
    ├── recruit.proto
    └── ...

src/protos/                # Generated TS — committed for review visibility (NEW)
├── session.ts
├── scheduler.ts
└── ...

scripts/
└── generate-protos.ts     # Wraps `protoc + ts-proto`; runs in `npm run build`
```

**Repo-root `protos/` over co-location** because:
- Single canonical location for the wire contract (matches `docs/WIRE-PROTOCOL.md` mental model)
- Future Python/Go consumers symlink or generate against `protos/` once; co-located shards force them to crawl the directory tree
- File-grouping semantics (one `.proto` per workflow domain) cleaner than 1:1 with TS files

**`shared.proto` for cross-cutting types** because protobuf imports across files are straightforward and avoid duplication. `Message`, `Attachment`, `AttachmentPhase` are referenced from session/maestro/outbox messages.

---

## 5. Versioning policy in `.proto` files

**Use field numbers + reserved ranges from day one.** Cheap upfront; expensive to retrofit.

```proto
// Example: src/workflows/signals.ts → protos/session.proto

message ReceiveMessageArgs {
  string from = 1;
  string text = 2;
  optional bool is_maestro = 3;
  optional bool is_scheduled = 4;
  optional string schedule_name = 5;
  optional bool response_requested = 6;

  reserved 7 to 15;  // Reserved for Phase 3 SSE-related additions
  reserved "deprecated_legacy_status";  // Pre-claim names we're never going back to
}
```

Conventions:
- **Reserve 1-32 for current-known fields**; 33-99 for near-term extensions (#318 `attachmentTicket`, #94/#95 SSE event ids); 100+ for unknown future
- **Mark every existing TS-optional field as proto3 `optional`** to preserve presence semantics (avoids the `??` audit issues from §1.2)
- **Reserved ranges per file** documented in `protos/README.md` so reviewers can verify no clobber
- **Numeric drift detector** in `test/proto-drift.test.ts` — fails if a reserved field number is repurposed without a corresponding reservation removal

Cross-file dependency tip: `shared.proto` defines `AttachmentPhase` as an enum; reserving values 0-7 for current phases (`booting`, `attached`, `processing`, `awaiting`, `draining`, `detached`, `gone`) leaves room for future refinements without renumbering.

---

## 6. Decode helper — ship in PR-1 (not deferred)

Issue #319 lists this as "worth building alongside, or skip until pain materializes." **Build it in PR-1.**

Reasoning:
- The "opaque base64 in `temporal workflow show`" ergonomic regression is a *daily-debugging* tax — not a one-time pain. Operators inspecting workflow history every day will hit this.
- It's small (~80 LoC) — `claude-tempo decode <payload-base64> [--message <name>]` reads a base64 payload, picks the right message type via the protobuf root, calls `Type.decode(buffer).toJSON()`.
- Without it, PR-3's 24h staging soak (per §1.3) is *much* harder — operators can't validate payload shapes during the soak window.

CLI integration:
```bash
$ claude-tempo decode CgVoZWxsbw==
{
  "from": "tempo-architect",
  "text": "hello",
  "responseRequested": true
}

$ claude-tempo decode CgVoZWxsbw== --message ReceiveMessageArgs
# Same — explicit type when payload doesn't carry the well-known type metadata
```

Implementation: lives at `src/cli/decode-command.ts`, registered alongside other crash-proof commands per `CLAUDE.md`'s CLI structure. No Temporal connection needed; pure protobuf decode.

---

## 7. Major version cutover — **v1.0.0**

Today's version (post-#326 merge): **v0.27.0**.

Two options:
- **v0.28.0** — bump within pre-1.0 era; signals "still beta but breaking"
- **v1.0.0** — bump to stable; signals "API surface stable, wire-protocol stable, breaking changes follow semver"

**Selected: v1.0.0.** Reasoning:
- Wire-protocol cutover is the cleanest moment to drop pre-1.0 semantics. Doing it later means *another* breaking change to mark v1.0 — diluting both.
- The Anthropic story benefits from a stable public-API claim. claude-tempo packages under `@anthropic-ai/claude-tempo-*` (or similar) reading "1.0.0" instead of "0.28.0" reduces consumer hesitation.
- Concrete commitment forcing function: shipping v1.0.0 means we can't add wire-protocol breaking changes without a v2.0.0 — disciplines future work.

Trade-off: a 1.0 ships with known v1 features only. Coat-check (#318) and SSE Phase 3 PR-4 should be in v1.0 baseline if the timing allows; otherwise they're v1.1 additive features (which is fine — additive doesn't break v1.0 contract).

**CHANGELOG header**: "v1.0.0 — wire-protocol cutover, no backward compat. See migration guide."

---

## 8. In-flight workflow cleanup automation — **fail-closed**

The new daemon **MUST refuse to start** if pre-protobuf workflows exist in the namespace.

```ts
// In src/daemon.ts startup
const preProtobufCount = await countPreProtobufWorkflows(client);
if (preProtobufCount > 0) {
  log.fatal(
    `Found ${preProtobufCount} pre-v1.0 workflows in namespace. ` +
    `Run 'claude-tempo down --destroy' on every active ensemble before ` +
    `starting the v1.0 daemon. Pre-v1.0 workflows are wire-incompatible with v1.0 workers.`
  );
  process.exit(1);
}
```

Detection: query for any workflow whose `WorkflowType` is one of ours and whose start time predates the v1.0 release. Cross-reference against a `ClaudeTempoWireVersion` search attribute (added in PR-1) that v1.0 workflows write at boot.

**Fail-closed beats warn-and-continue** because:
- Silent corruption is the worst possible outcome — v0 workflows interpreting v1 payloads (or vice versa) produce undefined behavior, not clean errors
- The forced operator action (destroy old workflows) is exactly what the migration guide documents
- One-time pain is better than weeks of "why is my workflow stuck?"

The detection check is fast (one `workflow.list` call) and runs once at daemon boot — operator pays the latency penalty only on first v1.0 boot.

---

## 9. Workflow code refactor strategy — **Option B (TS-interface-compatible)**

| Option | Surface change | Effort |
|---|---|---|
| **A — Native protobuf classes** (`CueArgs.create({...})` everywhere) | Every payload construction site changes | Heavy refactor — ~600+ LoC delta |
| **B — TS-interface-compatible** (`{ from: '...', text: '...' }` still works; ts-proto generated as plain interfaces) | Type-import swap; payload sites unchanged | Light refactor — ~200-300 LoC delta + audit fixes |

**Selected: Option B.** Reasoning:
- `ts-proto` with `outputClientImpl=false, useExactTypes=true` generates `interface ReceiveMessageArgs { from: string; text: string; isMaestro?: boolean; ... }` — almost identical to the current `src/types.ts` shape
- Payload construction sites (e.g. `entry = { type: 'cue', ... }` in `src/tools/cue.ts:38-42`) keep their object-literal style — only the imported type name changes
- Schema validation comes from the converter (proto3 wire format requires the right field types) — runtime check is automatic
- The Zod-based validation we already do in MCP tool handlers (`src/tools/helpers.ts`) stays in place — that's the *user-input* boundary, distinct from the *workflow-wire* boundary

**Trade-off**: we don't get protobuf class semantics (`oneof` discriminators auto-narrowed to TS unions, etc.) for free. ts-proto handles `oneof` reasonably as discriminated unions but it's slightly more verbose than hand-written. Acceptable.

The Option-B refactor delta is dominated by:
1. Determinism audit fixes from §1.2 / §10 (~9 sites mandatory; ~5-10 more belt-and-braces)
2. Type-import swap across `src/workflows/`, `src/activities/`, `src/tools/`, `src/client/` (~50-80 sites, mechanical)
3. Test-helper updates in `test/helpers.ts` for the new converter (~30 LoC)
4. Workflow-bundle update — generated types resolve via the existing bundler config (no manual wiring)

---

## 10. Determinism audit playbook (the load-bearing risk)

PR-2's mandatory checklist before merge. The implementer runs each step and records results in the PR description.

### 10.1 Audit grep targets

| Pattern | Action |
|---|---|
| `\?\? ['"][^'"]+['"]` | Inspect every site. Decide: keep `??` (mark proto field `optional`) OR switch to `\|\|` (accept `''` falsy-fallback) OR explicit `field !== undefined` check. |
| `=== undefined` / `!== undefined` | Inspect. Likely safe if field is marked `optional` in proto3 (preserves `undefined`); risky if not. |
| `if (!field)` where `field` is string | Inspect. `!''` is `true` — may match desired behavior or may not. |
| `field \|\| 0` / `field \|\| ''` | Generally safe — falsy-fallback covers both encodings. |
| `if (field === '')` | Inspect — under proto3 default, this matches "absent" which may not be intent. |

### 10.2 Test gates

| Test | Status target |
|---|---|
| Existing Mocha workflow integration suite | All green under new converter |
| Existing Vitest unit suite | All green (no encoding change at this boundary) |
| **NEW** `test/proto-determinism.test.ts` | Asserts every at-risk site has explicit handling (snapshot of grep results vs allowlist) |
| **NEW** `test/proto-drift.test.ts` | Asserts every signal/query/update name in `docs/WIRE-PROTOCOL.md` has a corresponding `.proto` message |
| Wire-protocol drift detector (existing `test/wire-protocol.test.ts`) | Updated to cross-check `.proto` names |

### 10.3 Per-PR gates

| PR | Audit checklist size | Soak required? |
|---|---|---|
| PR-1 | n/a (no wire change) | No |
| PR-2 | 9-15 line items (per §10.1) | No (no wire change yet) |
| PR-3 | 10-item operator checklist (§1.3) | **24h staging soak required before npm publish** |

---

## 11. Test strategy

| File | Suite | New / Updated |
|---|---|---|
| `test/proto-roundtrip.test.ts` | Mocha | NEW — for every message type, build TS object, encode, decode, assert deep-equal |
| `test/proto-drift.test.ts` | Mocha | NEW — `.proto` ↔ `docs/WIRE-PROTOCOL.md` ↔ TS exports must agree |
| `test/proto-determinism.test.ts` | Mocha | NEW — at-risk-pattern allowlist (per §10.1) |
| `test/wire-protocol.test.ts` | Mocha | UPDATE — cross-check against `.proto` names |
| `test/helpers.ts` (`TestWorkflowEnvironment` setup) | Mocha helper | UPDATE — pass `payloadConverterPath` |
| Existing `test/*.test.ts` workflow integration suites | Mocha | Re-run; expect a wave of fixes for default-value edge cases identified in §10.1 |
| Existing `tests/**/*.test.ts` Vitest suites | Vitest | No change — these don't cross workflow encoding boundary |

Estimated test fix wave size during PR-2: **~15-25 mocha tests** require updates for default-value semantics. Mostly mechanical.

---

## 12. Migration plan & cutover sequence

### 12.1 PR-1 — Foundation (~3-4 days, ~400 LoC + tooling)

1. Add `ts-proto` to `devDependencies`
2. Create `protos/` directory with `.proto` files for all 135 message types (per §2)
3. Add `scripts/generate-protos.ts` build step
4. Generated TS lands at `src/protos/`
5. **Decode helper** (§6) — `src/cli/decode-command.ts`, registered in CLI
6. `docs/WIRE-PROTOCOL.md` updated to reference `protos/*.proto` as canonical source
7. **Workflow code untouched** — converter not yet switched
8. Tests: roundtrip for every message; drift detector; existing test suite unchanged

**Rollback cost**: free — `git revert`

### 12.2 PR-2 — Code migration (~5-7 days, ~600-1000 LoC delta)

1. Type-import swap across `src/workflows/`, `src/activities/`, `src/tools/`, `src/client/`
2. **Determinism audit** (§10) — fix 9-15 mandatory sites; document audit allowlist
3. Update `test/helpers.ts` `TestWorkflowEnvironment` to pass new `payloadConverterPath`
4. Update Mocha workflow integration tests for default-value semantics (~15-25 tests)
5. **Converter not yet switched at runtime** — Wire format still JSON; PR validates the type-system migration without committing the wire change
6. Run full `npm test` matrix; fix every regression

**Rollback cost**: ~2-3 hours mechanical revert if downstream effects surface

### 12.3 PR-3 — Cutover + release (~1 day code + 24h soak + ops)

1. Set `payloadConverterPath` in `Client`, `Worker`, `TestWorkflowEnvironment` config
2. Add v1.0 fail-closed check (§8) to daemon boot
3. Bump version to **v1.0.0** in `package.json`
4. CHANGELOG entry with operator migration steps
5. **Pre-publish soak**: deploy to staging environment for ≥24h under realistic load. Validate via decode helper. Validate at least one CAN cycle.
6. **npm publish to `latest` tag**
7. Deprecate previous npm version with installation warning

**Rollback cost**: post-cutover painful. Republish previous tag + redeploy daemons + every operator runs `down --destroy && up`. Mitigated by §1.3 mitigations.

---

## 13. Implementation footprint

| File | Δ LoC |
|---|---|
| `protos/*.proto` | NEW ~135 messages, ~800 LoC |
| `src/protos/*.ts` | Generated, ~1500 LoC (committed for review) |
| `scripts/generate-protos.ts` | NEW ~50 LoC |
| `src/cli/decode-command.ts` | NEW ~80 LoC |
| `src/types.ts` | -200 (replaced by generated types) |
| `src/workflows/*.ts` | ~150 LoC delta (type imports + audit fixes) |
| `src/activities/*.ts` | ~80 LoC delta |
| `src/tools/*.ts` | ~50 LoC delta (sender-side type imports) |
| `src/client/*.ts` | ~30 LoC delta |
| `test/helpers.ts` | +30 LoC (converter wiring) |
| `test/proto-*.test.ts` | NEW ~400 LoC (3 new test files) |
| `test/wire-protocol.test.ts` | +20 LoC (drift detector update) |
| `package.json` | +1 dep, version 1.0.0 |
| `CHANGELOG.md` | +50 lines |
| `docs/WIRE-PROTOCOL.md` | +20 lines (proto cross-references) |
| `docs/ops/v1.0-migration.md` | NEW ~100 LoC operator guide |

**Net**: ~2700 LoC across 3 PRs. Issue #319's "~1,000-1,400 LoC" estimate undercounts by including only delta to existing files; the generated TS + new test files inflate the total. **Honest estimate: 2-2.5 weeks** for one engineer working full-time, with the pole being PR-2's audit + test-fix wave.

---

## 14. Alternatives considered

### 14.1 Defer entirely (do nothing)

**Rejected**: vinceblank already accepted the cost ceiling; the schema-evolution discipline win is real; pre-1.0 is the cheapest moment. Deferring just means doing it under harder constraints later.

### 14.2 JSON + Zod for runtime schema validation (no protobuf)

Proposed alternative: keep JSON wire format; add Zod schemas at every signal/query/update boundary; validate at receive time.

**Rejected**: gives runtime schema validation BUT misses:
- Wire-format size/efficiency (modest win, but real)
- Schema-as-types codegen (Zod schemas are runtime; protobuf is build-time → static types)
- Cross-language (Zod is TS-only)
- Versioning discipline (Zod doesn't enforce field numbers / reserved ranges)

The "schema-discipline" win specifically requires protobuf; Zod alone doesn't deliver it.

### 14.3 Partial migration — protobuf for new types, JSON for existing

**Rejected** per #319's explicit constraint and on technical grounds: dual-encoding requires an "is this JSON or protobuf?" branch on every receive. Operationally fragile; the "single encoding story" is half the win.

### 14.4 Use `temporal` Cloud's built-in protobuf support

Temporal supports protobuf natively (the converter primitives we'd use are part of `@temporalio/common`). This isn't really an alternative to our approach — it's the foundation we'd build on. Listed for completeness.

### 14.5 Defer until a non-TS consumer materializes

**Rejected**: by then the audit cost is higher (more workflow code accumulated using JSON-default semantics) and the cutover is harder (more in-flight workflows to destroy). The argument-against-now-is-actually-an-argument-for-now.

### 14.6 Migrate workflow types only, leave activity I/O on JSON

**Rejected**: activities cross workflow boundaries via `proxyActivities`; their I/O payloads are subject to the same Temporal payload converter. Mixed migration is no migration — converter is per-Client, not per-message-type.

---

## 15. Open questions resolved

Issue #319 listed six. My recommendations:

| # | Question | Resolution |
|---|---|---|
| 1 | `ts-proto` vs `protoc-gen-ts` vs hand-written | **`ts-proto`** — §3 |
| 2 | Repository layout — `protos/` at root vs co-located | **`protos/` at repo root**; `src/protos/` for generated TS — §4 |
| 3 | Versioning policy in `.proto` files | **Field numbers + reserved ranges from day 1** — §5 |
| 4 | Decode helper — build alongside or skip | **Build in PR-1, not deferred** — §6 |
| 5 | Major version cutover or v0.28.0 | **v1.0.0** — §7 |
| 6 | In-flight workflow cleanup — refuse-to-start or warn | **Fail-closed (refuse to start)** — §8 |

Plus the conductor's #7 and #8 from the dispatch:

| # | Question | Resolution |
|---|---|---|
| 7 | Workflow refactor — Option A (classes) vs Option B (interfaces) | **Option B** — §9 |
| 8 | Determinism audit checklist | **§10 playbook** — 9-15 mandatory sites, codified test gates |

---

## 16. Sequencing

Per #319: **after #94/#95 SSE work lands.** Refined per the conductor's dispatch:

1. ✅ Phase 3 PR-1 (SSE snapshot endpoints) — landed
2. ✅ Phase 3 PR-2 (SSE streaming) — landed
3. PR-3 (TempoClient.subscribe) — in flight (eng-4)
4. PR-4 (TUI cutover + ink-scroll-view) — pending
5. **48h soak after PR-4** — per #316 mandate
6. **#318 implementation** — per #319 sequencing
7. **#319 implementation begins** — this design's PR-1 starts here

Estimated calendar: protobuf work begins ~3-4 weeks out from this design landing. **Locks the design now; implementer picks up cold.**

---

## 17. Sources

- Issue #319 — full motivation, 3-PR plan, 6 open questions, 2-week estimate, sequencing recommendation
- `docs/WIRE-PROTOCOL.md` (153 rows verified)
- `src/workflows/*.ts` — `??` audit grep verifying §1.2 risk count
- `node_modules/@temporalio/common/lib/converter/protobuf-payload-converters.d.ts` — confirmed SDK protobuf primitives are in-place
- `node_modules/protobufjs` — already a transitive dep; no new runtime dep on protobuf side
- `npm view ts-proto` (2026-04-26) — v2.11.6, actively maintained, ~50K weekly downloads
- PRs #326 (TempoClient split), #327 (coat-check) — same design-spike template precedent
- ADR 0009 — decision record for this design
