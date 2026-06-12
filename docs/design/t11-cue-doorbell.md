# T1.1 — Cue Doorbell: push-nudged delivery over the daemon HTTP plane

> **Status**: DESIGN — operator-approved as a design task only (#747 Tier 1). No implementation
> until this doc passes the human gate.
> **Author**: tempo-architect · 2026-06-12 · designed against main @ `560303b3` (post-Tier-0:
> #757 SA diet, #759 maestro V2, #761 idle backoff, #762 pendingIntake, #764 demand gate, #766 costProfile operator path).
> **Parent**: [temporal-cost-rearchitecture.md](temporal-cost-rearchitecture.md) §Tier 1, T1.1.
> **Constraints (operator-mandated)**: zero wire-protocol renames · additive only · D14 reset
> semantics untouched.

## 1. The invariant

> **"Doorbell loss must be indistinguishable from doorbell-never-sent."**

The session workflow's inbox remains the **sole source of truth** for message delivery. The
doorbell is a content-free latency hint: *"it may be worth polling now."* Polling remains the
guaranteed delivery path — the doorbell only decides **when** the next poll happens, never
**whether** a message is delivered.

Three structural consequences, each load-bearing:

1. **No payload.** A doorbell carries `{ensemble, playerId}` and nothing else. The adapter's
   reaction is exactly its existing poll (`pendingMessages` / `pendingIntake`) + existing acks
   (`markDelivered` / `ackReset`). There is no second delivery channel to keep consistent.
2. **No persistence, no replay.** Doorbells are in-memory, ephemeral, at-most-once — the
   inner-loop class of traffic (`src/http/inner-loop.ts`: "NOT on Temporal/bus, ephemeral
   no-replay"). A doorbell that dies with a daemon restart was, by the invariant, never sent.
3. **No new acks, no new workflow state.** Nothing on the Temporal wire changes. The wire
   surface of this feature is exactly zero signals/queries/updates.

Anything that would violate one of these three (a payload-carrying doorbell, a persisted
doorbell queue, a "doorbell received" ack) is out of scope by definition, not by deferral.

## 2. Mechanism

### 2.1 Where the doorbell originates

`deliverCue` in `src/activities/outbox.ts` already runs **inside the daemon worker process**
and is the exact moment a `receiveMessage` signal lands on the recipient workflow. After the
signal call resolves (durably in history), the activity rings a late-wired in-process sink:

```ts
// activities/outbox.ts — after handle.signal(receiveMessageSignal, …) resolves:
doorbells?.current?.ring(ensemble, targetPlayerId);
```

`deliverReset` rings the same sink the same way. **D14 is untouched**: the single-slot,
latest-wins, id-matched `ackReset` semantics live entirely on the workflow; the doorbell only
shortens the time until the pump's next `tickReset` looks.

Wiring follows the two established late-wiring precedents (`IngestTokenRegistry`,
`ObserverPresenceSource` from #759): activity construction happens before the HTTP plane
exists, so the activity options carry a mutable holder the daemon fills in at boot. A worker
process that is *not* the daemon (none exist today — all workers run in the daemon) simply has
a null sink: ring() is a no-op, fallback polling covers it. Invariant holds.

### 2.2 The DoorbellRegistry (daemon, in-process)

A dedicated registry modeled on `InnerLoopRegistry` (3c MD-F) — **deliberately NOT the
EnsembleEventBus**:

- Doorbells are not board events. Putting them on the bus would (a) spray every cue delivery
  to every dashboard subscriber, (b) entangle them with ring-buffer replay they must not have
  (replayed doorbell ≈ persisted doorbell — violates §1.2), and (c) contaminate
  `totalSubscriberCount()` — see §4 (T0.4) below.
- Shape: `Map<"{ensemble}:{playerId}", Set<waiter>>`; `ring()` resolves/notifies waiters;
  no queue, no buffer — a ring with no listener is dropped on the floor (§1: indistinguishable
  from never-sent).

### 2.3 How an adapter subscribes

A new daemon HTTP route, mirroring the inner-loop INGRESS conventions:

```
GET /doorbell/:ensemble/:playerId        (SSE; loopback-only + X-Ingest-Token)
```

- **Auth**: loopback + the per-player ingest token (`AGENT_TEMPO_INGEST_TOKEN`), exactly the
  inner-loop ingress model — minted at spawn, revoked on destroy, timing-safe validation,
  cross-player-spoof guard. Adapters already receive this env var; no new credential
  distribution. Token absent (manual launches, older spawns) → adapter never subscribes →
  pure T0.2 behavior. *(Today the token is minted on Pi spawn — PR-1 extends minting to all
  adapter spawns; the registry and route are player-type-agnostic already.)*
- **Events**: content-free `ding` events. No event IDs, no `Last-Event-ID`, no replay —
  deliberately not the §5 SSE envelope, because replay is forbidden by §1.2.
- **Not** `/v1/events`: doorbell connections must be invisible to the board-demand machinery
  (§4) and must not receive board traffic.

### 2.4 What the adapter does with it

One shared client (`DoorbellClient`, in `src/adapters/sdk/`) consumed by `SdkAttachment` and
the Pi runtime:

- On `ding`: trigger an immediate poll tick (the existing fetch + inject + ack sequence) and
  `pollBackoff.reset()` (T0.2's `IdleBackoff`).
- Connection state drives the idle ceiling (one new knob, additive):
  - **Doorbell connected**: idle backoff may stretch to `SDK_POLL_DOORBELL_MAX_MS = 60_000`
    (latency is the doorbell's job; the 60s poll is reconciliation).
  - **Doorbell disconnected / never connected**: the T0.2 ceiling (30s) governs — i.e.
    **today's shipped behavior is the floor**. Daemon down ⇒ cost and latency revert to
    exactly post-#761 behavior, automatically.
- Reconnect loop with capped backoff; every disconnect/reconnect transition logs one
  `[agent-tempo:doorbell]` breadcrumb (the #249 observability lesson).

**Why 60s and not 5min**: the doorbell is at-most-once with no replay; the fallback poll is
the *only* bound on worst-case delivery latency after a lost ding (e.g. ring raced the
subscribe). 60s keeps that worst case operator-tolerable while still cutting connected-idle
polling another 2× below T0.2. Stretching further is a knob-turn later, informed by the meter
— not a design change.

### 2.5 Daemon restarts

- Registry and connections are in-memory; a restart drops both. Adapters reconnect with
  backoff; while disconnected they poll at the 30s ceiling. Nothing to replay (§1.2).
- The elegant closure: while the daemon is down, **no doorbells are being missed** — cue
  delivery itself runs as an activity *in the daemon worker*, so deliveries pause with the
  daemon and resume (with retries + rings) when it returns. The doorbell channel and the
  thing it announces share fate.

## 3. Interaction matrix with landed Tier 0

| Landed | Interaction | Ruling |
|---|---|---|
| **T0.2 IdleBackoff (#761)** | `ding` ⇒ immediate tick + `reset()`. Connected state raises only the ceiling (`maxMs` 30s→60s); base/factor/reset semantics untouched. The pure, timer-free helper was built as this exact plug-in point — only its config source grows. | Compose; no rework. |
| **T0.3 pendingIntake (#762)** | The doorbell-triggered tick IS a normal tick: Pi fetches the combined intake (1 query), SDK adapters fetch `pendingMessages`. `deliverReset` rings too, so a reset reaches a stretched pump at ding-latency, not 60s. Ack/id-match semantics untouched (D14 constraint). | Compose; no rework. |
| **T0.4 demand gate (#764)** | **A doorbell is NOT demand — by construction.** Doorbell connections live on the DoorbellRegistry, not the event bus, so `totalSubscriberCount()` never sees them; rings don't `wake()` the aggregate. If doorbell subscriptions counted as demand, every idle player would hold the daemon at 750ms full-cadence 24/7 and erase T0.4 (and T0.1's presence gate, which keys on the same count via `ObserverPresenceSource`). This is the single most important integration rule in this design. | Hard rule; enforced structurally + by a conformance test (PR-1). |
| **T0.1 presence gate (#759)** | Same rule, same mechanism: `observersPresent` keys on bus subscribers only. Doorbell traffic never makes an unwatched maestro think someone is watching. | Same hard rule. |
| **Pi cue pump** | The pump's fixed 1s tick becomes IdleBackoff-governed (1s base → 60s connected / 30s disconnected ceiling) + ding-triggered ticks. This is the largest single win: an idle connected Pi player goes from 86,400 ticks/day (T0.3: 1 query each) to ~1,440 + dings. Escalation (#677) and re-entrancy guards operate per-tick and are cadence-independent. | Compose; pump gains a backoff it never had. |
| **costProfile (#759/#766)** | Per the T0.2 ruling (delivery-path parity): the doorbell is delivery-path ⇒ **NOT gated by costProfile**. It is gated by capability (token present + daemon reachable) and degrades to T0.2 behavior. Mock-adapter dev-mode E2E exercises the identical state machine. | Ungated, like T0.2. |

## 4. Multi-host story (v1 bound)

Outbox delivery activities run on the **shared** task queue — with multiple daemons connected,
a delivery for a player on host B may execute on host A's worker. Host A's ring lands on host
A's registry; the adapter listens to its own loopback daemon on host B; the ding is lost —
**which is fine** (§1: indistinguishable from never-sent; B's fallback poll delivers within
its ceiling).

**v1 bound, stated honestly**: the doorbell is a *guaranteed* latency win on single-host
ensembles (one daemon ⇒ ring is always local — the overwhelmingly common case) and a
*probabilistic* one on multi-host (P(activity lands on recipient's host) ≈ that host's share
of shared-queue pollers). Correctness is identical everywhere.

**v2 (explicitly deferred, do not build now)**: cross-host ring via the recipient daemon's
HTTP ingest, or a per-host ring activity on the existing `agent-tempo-{hostname}` queue.
Both cost real things (daemon address discovery — `hostProfiles` carries no address by
privacy design; or +1 billable action per cue). Revisit trigger: a meter showing multi-host
ensembles materially represented AND first-cue latency complaints from them.

## 5. Failure-mode table

| Failure | What happens | Degrades to |
|---|---|---|
| Doorbell lost (no listener, raced subscribe, SSE write fails) | Ring drops on the floor; nothing logged above debug | Fallback poll ≤ ceiling (60s) — *indistinguishable from never-sent* |
| Doorbell duplicated (retry of delivery activity re-rings) | Extra poll tick; fetch returns empty or already-fetched batch; acks idempotent | One wasted query; behavior identical to a coincidental poll |
| Doorbell before subscribe (cue lands while adapter boots) | No listener → dropped; adapter's first polls run at base cadence (backoff starts fresh at 2s/1s) | The cue is picked up by the initial fast polls — startup was never doorbell-dependent |
| Daemon down | No SSE, and no deliveries either (delivery activity runs in the daemon worker — shared fate, §2.5); adapter detects disconnect, ceiling drops to 30s | Exactly post-#761 (T0.2) behavior |
| Daemon up, registry bug / route 500s | Adapter reconnect loop fails, stays in disconnected state | Exactly post-#761 behavior |
| Adapter never had a token (manual launch, old spawn) | Never subscribes | Exactly post-#761 behavior |

Every row's right-hand column is some version of "today's shipped behavior" — that is the
invariant made operational.

## 6. Sizing + PR split

| PR | Content | Est. | Risk |
|---|---|---|---|
| **PR-1: daemon side** | `DoorbellRegistry` + `/doorbell` SSE route (ingest-token auth) + late-wired sink in `deliverCue`/`deliverReset` + ingest-token minting extended to all adapter spawns + **conformance test: doorbell connections never affect `totalSubscriberCount()`/`observersPresent`** | ~200–250 LOC + tests | LOW (additive, in-memory, no Temporal surface) |
| **PR-2: SDK adapters** | `DoorbellClient` (reconnecting SSE consumer) + `SdkAttachment` wiring (ding→tick+reset; connected-ceiling knob `SDK_POLL_DOORBELL_MAX_MS`) | ~200 LOC + tests | LOW-MED (adapter loop state machine; mock adapter gives dev-mode E2E) |
| **PR-3: Pi pump** | Pump adopts IdleBackoff + DoorbellClient; extension wiring | ~150 LOC + tests | MED (the pump's re-entrancy/escalation paths are subtle — #677 history; tests must cover ding-during-tick) |
| **PR-4: docs/ops** | WIRE-PROTOCOL **no-op note** (explicitly: no wire change), SSE-PROTOCOL §doorbell route, ops note (latency expectations table), meter before/after | docs | — |

PR-2 and PR-3 are independent once PR-1 lands. Total ≈ 550–600 LOC, consistent with the
parent doc's T1.1 estimate.

**Expected effect** (meter to confirm): connected-idle per-player polling drops ~2× below
T0.2 (30s→60s ceiling) and the Pi pump ~30–60× (1s→backoff), while first-cue latency drops
from "up to ceiling" to sub-second whenever the doorbell path is live — removing the only
UX regression Tier 0 accepted.

## 7. Non-goals (parked, with revisit triggers)

- **T1.2 worker-side change tap**: not in this design. Revisit trigger: post-Tier-0 meter
  shows the Window-A residual (aggregate/maestro observation polling) still material.
- **T1.3 tiered liveness**: not in this design; touches the #249-stabilized attachment
  machinery and carries the both-dead crash-detection trade. Revisit trigger: operator
  sign-off required; sequenced last per the parent doc.
- **Cross-host doorbell (v2)**: see §4 bound + trigger.
- **Doorbell payloads / replay / acks**: excluded by the §1 invariant, permanently.
