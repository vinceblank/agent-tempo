# Cross-host orphans

A **cross-host orphan** is a session workflow whose attachment phase is
live (`detached`, `draining`, `attached`, `processing`, or `awaiting`)
but whose home-host daemon isn't running an adapter for it — typically
because the host went down, the daemon crashed without an orderly
destroy, or the host's process tree was killed while the workflow was
mid-CAN. The workflow stays alive in Temporal; only the adapter is
gone. The session needs a human to either pick it back up on another
host or destroy it for good.

Before #579, finding these required SSHing to each daemon host and
running `agent-tempo restore --all-hosts`. The dashboard's
**`/orphans`** view (sidebar entry "Orphans") surfaces them
cluster-wide so any operator on any live host can see what needs
attention.

## Dashboard view

Sidebar → **Orphans**. Columns:

| Column | What it means |
|---|---|
| **Player** | `playerId` + the trailing segment of the workflow id (mono, full id on hover) |
| **Ensemble** | The orphan's ensemble — useful when multiple lineups are in flight |
| **Host** | `preferredHost` from the workflow's `SessionMetadata` (where the adapter was last seen) |
| **Status** | Liveness glyph + label: `● live` / `◐ stale` / `✗ missing`, plus the relative-age of `detachedSince` |
| **Action** | Copy-button for the rendered `/migrate` slash-command |

The panel is wrapped in a soft amber border — orphans want attention
but they're not a hard failure. The view is **read-only in v1**: no
click-to-restore, no click-to-destroy. Recovery is operator-side via
the copied slash-command.

A badge on the sidebar nav entry shows the total count when > 0.

## Recovery flow

1. **Pick an orphan.** Open the dashboard's Orphans view; pick the row
   you want to recover.
2. **Copy the `/migrate` command.** Click the copy button in the
   Action column. The command targets the orphan's `preferredHost`
   when known:
   ```
   /migrate <player> <preferredHost>
   ```
   When `preferredHost` is null, the rendered command targets the
   dashboard's local host and pre-fills the cross-host steal guard
   with the last-known adapter host:
   ```
   /migrate <player> <dashboardHost> --force --yes-steal=<lastKnownHost>
   ```
   If even the last-known host is missing, the command falls through
   to a literal `(unknown)` placeholder — you **must** edit it to a
   real hostname before submitting, or `/migrate`'s tokenizer will
   reject the command.
3. **Paste into a live session on the target host.** Any TUI session
   on `<host>` will do — the slash-command needs an operator player
   identity for the steal-guard audit trail.
4. **Watch the migration land.** The target host's daemon picks up the
   `restart` outbox entry, claims the attachment fresh, and spawns a
   new adapter. The orphan row drops off the dashboard's next 30-second
   refresh (sooner via the Re-scan button in the page header).

## Why no click-to-restore in v1?

The architect's [design discussion](https://github.com/vinceblank/agent-tempo/issues/579)
landed on view-only for the first release because:

- Cross-host restore is a deliberate-action operation (the §16.5
  `--yes-steal=<host>` gate exists exactly so an operator types the
  source host into a slot they had to think about). A one-click
  dashboard button would invert that guarantee.
- The dashboard runs in a browser session that may not match the
  operator's TUI session. The slash-command path preserves the audit
  identity correctly (the player executing the TUI command is the
  recorded invoker); a dashboard click would record the daemon's host
  identity, masking who actually decided to migrate.
- Operators consistently report that they want orphan **visibility**
  before they want orphan **action**. v1 ships the former and leaves
  the latter as deliberate follow-up if the visibility surface
  changes the kinds of decisions being made.

If the operator's #1 desire after a month of running the dashboard is
a "Migrate to this host" button, we'll add it then — with the steal
guard surfaced as a confirmation modal that mirrors the TUI's
`--yes-steal=` payload.

## When does an orphan appear?

Common causes:

- **Daemon process killed without `agent-tempo down`** — the workflow
  stays in `attached` phase until the lease expires (60-90s), then
  reaps itself to `detached`. The dashboard surfaces it as soon as
  the visibility query is refreshed (3s daemon cache + 30s dashboard
  refetch).
- **Host shutdown / reboot without graceful teardown** — same as above.
- **Adapter crashed but workflow didn't notice** — `attached` without
  heartbeats; reaps to `detached` after the lease window.
- **`/migrate` against a host with no daemon** — the workflow lands in
  `detached` permanently until you point it at a live host.

Orphans **never** appear for:

- Sessions destroyed with `destroy` or `agent-tempo down --destroy`
  (those flip phase to `gone` and the workflow completes).
- Sessions held in `booting` waiting for their first claim (those
  haven't established a `preferredHost` yet).
- Sessions on the local host where the dashboard daemon is running
  — those are visible in the ensemble's normal player list.

## Auth + wire reference

The endpoint is `GET /v1/orphans[?ensemble=<name>]`, response shape
`OrphansV1` (`src/http/event-types.ts`). Bearer + CORS gates identical
to `/v1/hosts`. The daemon caches the underlying read for 3 s keyed by
ensemble filter; the dashboard React Query layer adds a 30 s
`refetchInterval` for the full list and 60 s for the sidebar count.

See [`docs/SSE-PROTOCOL.md` §4.5](../SSE-PROTOCOL.md#45-v1orphansensemblename-579)
for the wire contract.

## Related

- [`agent-tempo restore --all-hosts` CLI](../cli.md) — the equivalent CLI surface (#151)
- [`/migrate` TUI slash-command](../tui.md#migrate) — the recovery action this view feeds
- `src/reconcile/orphans.ts:queryOrphanedSessions` — the visibility query that powers both surfaces
