# ADR 0009 — Full protobuf payload migration strategy

- **Status**: Accepted (design — implementation deferred to post-#318 per issue #319 sequencing)
- **Date**: 2026-04-26
- **Authors**: tempo-architect
- **Related**: [`docs/design/protobuf-migration.md`](../design/protobuf-migration.md), issue #319

## Context

Today every workflow payload (signals, queries, updates, workflow inputs/outputs, activity I/O) is encoded as JSON via the SDK default converter. ~135 distinct message types cross workflow boundaries; ~68 named wire-protocol contracts (signals/queries/updates) plus ~25 activity I/O types plus ~10 outbox-entry variants plus shared sub-types.

vinceblank approved issue #319 — a full coordinated cutover from JSON to protobuf. No backward compatibility, no per-type opt-in, no partial migration. Implementation sequenced post-Phase-3-PR-4 + 48h soak + #318 implementation.

The design spike was tasked with answering three load-bearing questions before the implementer picks up the work:

1. **Is the JSON pain real today?** — verifies cost-justification
2. **Is the determinism audit tractable?** — verifies that proto3 zero-default semantics don't trigger a multi-month rewrite
3. **Is the rollback story real?** — verifies the operational risk is bounded

And to lock down 8 open design decisions that gate implementation.

## Decision

**Proceed with the migration as a coordinated 3-PR cutover, with explicit gates.** The full design — surface inventory, tooling choice, repo layout, versioning, decode helper, workflow refactor strategy, determinism audit playbook, rollback story, test strategy — lives at [`docs/design/protobuf-migration.md`](../design/protobuf-migration.md). This ADR records the decision; that doc records the design.

Headline locked-in choices:

- **Tooling**: `ts-proto` v2 with `outputClientImpl=false, useExactTypes=true` — generates plain TS interfaces matching existing `src/types.ts` shape
- **Layout**: `protos/` at repo root for `.proto` source; `src/protos/` for generated TS (committed for review visibility)
- **Versioning**: field numbers + reserved ranges from day 1; proto3 `optional` keyword on every existing TS-optional field
- **Decode helper**: ship in PR-1, NOT deferred — `agent-tempo decode <payload-base64>` is a daily-debugging requirement, not a nice-to-have
- **Major version**: **v1.0.0** (drops pre-1.0 era; wire-protocol cutover is the cleanest moment)
- **In-flight workflows**: fail-closed — daemon refuses to start if pre-v1.0 workflows exist
- **Refactor strategy**: Option B (TS-interface-compatible) — minimizes churn; payload construction sites unchanged
- **Determinism audit**: 9-15 mandatory at-risk sites identified; PR-2 checklist gate

## Consequences

- **Positive**:
  - **Schema as wire contract** — `.proto` files become the single source of truth; field-number reservations + `optional` discipline make schema evolution typecheckable
  - **Single encoding story** — no future bifurcation between JSON and protobuf branches; the operational mental model gets simpler
  - **Foundation for cross-language SDKs** — Python adapter / Go worker can be authored without re-deriving the wire shape
  - **Modest wire-size win** — ~30-50% smaller payloads for repeated structures; not pivotal at our scale but compounds
  - **v1.0.0 release** — concrete commitment that disciplines future breaking-change decisions
  - **Decode helper** mitigates the "opaque base64 in `temporal workflow show`" daily-debugging tax
- **Negative**:
  - **2-2.5 week dedicated workstream** — ~2700 LoC across 3 PRs, with PR-2's determinism audit as the long pole
  - **Post-cutover rollback is painful** — every operator runs `agent-tempo down --destroy && up`; one-time burden but unavoidable. Mitigated by 24h staging soak before npm publish.
  - **`temporal workflow show` UI shows opaque base64** for in-flight payloads — daily ergonomics regression mitigated (not eliminated) by the decode helper
  - **Generated TS in source control** — PR diffs show generated code; mitigated by reviewer convention (skim generated files, focus on `.proto` source)
  - **Build complexity** — `ts-proto` becomes a build-time dependency; `scripts/generate-protos.ts` runs in `npm run build`
- **Neutral**:
  - **Determinism audit is tractable** — 9-15 mandatory at-risk `?? '<string>'` sites identified; well under the 50-site threshold the spike committed to surface as a re-scope signal. Audit fixes are mechanical.
  - **SDK protobuf primitives are already in `@temporalio/common`** — `ProtobufBinaryPayloadConverter` and `DefaultPayloadConverterWithProtobufs` are imports, not new code

## Alternatives considered

- **Defer entirely** — rejected. vinceblank already accepted the cost ceiling; pre-1.0 is the cheapest moment; deferring means doing it under harder constraints later.
- **JSON + Zod for runtime schema validation** — rejected. Gives runtime validation but misses wire-format efficiency, schema-as-codegen, cross-language compat, and versioning discipline. The schema-discipline win specifically requires protobuf.
- **Partial migration** (protobuf for new types, JSON for existing) — rejected per #319 constraint and on technical grounds (per-Client converter, not per-message). Dual-encoding "is this JSON or protobuf?" branching is half the cost without half the benefit.
- **Defer until a non-TS consumer materializes** — rejected. By then the audit cost is higher (more code accumulated under JSON-default semantics) and the cutover is harder (more in-flight workflows). Argument-against-now is actually argument-for-now.
- **Workflow types only, leave activity I/O on JSON** — rejected. Converter is per-Client, not per-message-type; mixed migration is no migration.
- **`protoc-gen-ts`** instead of ts-proto — rejected. Class wrappers (`Foo.create({...})`) ripple through every payload-construction site; ts-proto's plain-interface output is closer to existing patterns.
- **Hand-written `.proto` + protobufjs runtime parsing** — rejected. Gives up the schema-as-types static-typing win.

## Forward-looking notes

- **Coat-check (#318)** can ship under JSON v1; once protobuf migration lands, coat-check entries get `.proto` definitions in PR-1's surface inventory. The two designs don't compete sequentially — #318 implementation runs first per its own sequencing.
- **SSE event source (#94/#95)** payloads stay on JSON for v1 even post-migration — they're a separate consumer-facing wire (HTTP/SSE, not Temporal). Evaluate protobuf for SSE separately if/when audit benefits justify.
- **Wire-protocol additions post-v1.0** must register with the protobuf field-number plan in `protos/README.md` reservations log. Drift detector (`test/proto-drift.test.ts`) enforces.
- **A v2.0.0 protobuf-incompatible change** would require the same operator-coordinated destroy-and-restart cutover as this v1.0. The pattern is reusable, but each one is expensive — discipline against unnecessary breaks.

## References

- [`docs/design/protobuf-migration.md`](../design/protobuf-migration.md) — full design (17 sections, 600+ LoC)
- Issue #319 — original proposal with motivation, 3-PR plan, 6 open questions, sequencing
- `docs/WIRE-PROTOCOL.md` — current 68 named wire-protocol contracts
- `node_modules/@temporalio/common/lib/converter/protobuf-payload-converters.d.ts` — SDK protobuf primitives
- ts-proto v2.11.6 (npm registry, 2026-04-26) — selected tooling
- ADR 0007 (TempoClient Core/WithSpawn split), ADR 0008 (coat-check pattern) — same design-spike template precedent
