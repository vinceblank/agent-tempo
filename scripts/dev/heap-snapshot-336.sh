#!/usr/bin/env bash
# heap-snapshot-336.sh — throwaway reproducer harness for issue #336.
#
# Issue: claude-tempo daemon RSS grows to 1.1 GB after 17 h sustained
# ensemble activity. Suspect (per the 2026-05-11 diagnostic spike): gRPC
# stream-buffer retention from the six un-bounded visibility iterators
# in the daemon hot path (#529).
#
# This script drives synthetic recruit-and-destroy cycles against the
# dev daemon's mock ensemble, asking the operator to capture heap
# snapshots at three checkpoints (0 / mid / end). Diffing the snapshots
# in Chrome DevTools should name the actual retainer — if it's grpc-js
# channel state or @temporalio/proto WorkflowExecutionInfo, the
# iterator-deadline fix (also closes #529) is the right remedy.
#
# **Dev-only.** Not shipped, not invoked by CI. Output (.heapsnapshot,
# .heapprofile, log tail) is gitignored under scripts/dev/.out/.
#
# Usage:
#   1. Boot the dev daemon manually with one of:
#        # Interactive (Chrome DevTools attach @ chrome://inspect):
#        node --inspect=0.0.0.0:9229 dist/daemon.js --dev
#
#        # Automated (writes .heapprofile to cwd on exit):
#        node --heap-prof --heap-prof-name=daemon-336.heapprofile dist/daemon.js --dev
#
#   2. In a second shell, run this script:
#        ./scripts/dev/heap-snapshot-336.sh [CYCLES] [INTERVAL_SEC]
#
#      CYCLES (default 1000) — number of recruit-and-destroy cycles
#      INTERVAL_SEC (default 0) — sleep between cycles (0 = as fast as possible)
#
#   3. At each prompt, capture a heap snapshot via Chrome DevTools
#      ("Memory" tab → "Take heap snapshot" against the daemon's PID).
#      Save to scripts/dev/.out/snapshot-{0,500,1000}.heapsnapshot
#
#   4. Open all three snapshots in DevTools and use "Comparison" view to
#      diff retained sizes. Look for growth in:
#        - @grpc/grpc-js Channel / Subchannel / Call objects
#        - @temporalio/proto WorkflowExecutionInfo / Payload buffers
#        - Closures retaining `Connection` or `Client` objects
#
#   5. On exit (Ctrl+C or workflow completion) the daemon flushes its
#      .heapprofile if you booted with --heap-prof. Open with:
#        node --prof-process daemon-336.heapprofile
#      Or load the .heapprofile in Chrome DevTools → Memory → Allocation
#      sampling profile.
#
# Expected baseline (clean tree, pre-fix):
#   - cycle 0:    daemon RSS ~80–120 MB
#   - cycle 500:  daemon RSS grows; @temporalio/proto retainers visible
#   - cycle 1000: daemon RSS materially higher; same retainers compounded
#
# Expected post-fix (visibility-iterator deadlines landed):
#   - cycle 1000 RSS stays within ~2× cycle 0 baseline
#   - grpc-js Subchannel object count stable
#
# If post-fix snapshots still show growth, #336 stays open with a
# sharper "leak is elsewhere" signal; harness output names the retainer.

set -euo pipefail

# ── Args ───────────────────────────────────────────────────────────────
CYCLES="${1:-1000}"
INTERVAL_SEC="${2:-0}"

# ── Constants ──────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR="$SCRIPT_DIR/.out"
LINEUP="tempo-mock-jam"
ENSEMBLE_NAME="tempo-mock-jam"   # name comes from the lineup yaml
CYCLE_PLAYER_PREFIX="heap-336-probe"

# Checkpoint markers — operator captures a snapshot at each.
CHECKPOINTS=(0 $((CYCLES / 2)) "$CYCLES")

mkdir -p "$OUT_DIR"

# ── Helpers ────────────────────────────────────────────────────────────
log() { printf '[heap-336 %s] %s\n' "$(date +%H:%M:%S)" "$*"; }

# Cross-platform: prefer `node dist/cli.js --dev` (canonical entry per
# CLAUDE.md dev-mode section). Falls back to `claude-tempo --dev` if a
# global install is present.
ct() {
  if [ -f "$REPO_ROOT/dist/cli.js" ]; then
    node "$REPO_ROOT/dist/cli.js" --dev "$@"
  else
    claude-tempo --dev "$@"
  fi
}

# Prompt operator at a checkpoint and wait for ENTER.
checkpoint() {
  local cycle="$1"
  log "── CHECKPOINT cycle=$cycle ──"
  log "Capture heap snapshot now:"
  log "  Chrome DevTools (interactive):  chrome://inspect → Memory → Take heap snapshot"
  log "  Save as: $OUT_DIR/snapshot-${cycle}.heapsnapshot"
  log ""
  log "If running with --heap-prof, the daemon writes .heapprofile on exit;"
  log "this checkpoint is a no-op then. Press ENTER to continue, Ctrl+C to abort."
  read -r _
}

# ── Pre-flight ─────────────────────────────────────────────────────────
log "Pre-flight: confirm dev daemon is running."
if ! ct daemon status >/dev/null 2>&1; then
  log "ERROR: dev daemon is not running. Boot it first (see header)."
  exit 1
fi

log "Pre-flight: ensure $LINEUP is up."
ct up --lineup "$LINEUP" >/dev/null 2>&1 || true

log "Plan: $CYCLES cycles, checkpoints at: ${CHECKPOINTS[*]}"
log "Output dir: $OUT_DIR"

# ── Cycle loop ─────────────────────────────────────────────────────────
checkpoint 0

START_TS=$(date +%s)
for i in $(seq 1 "$CYCLES"); do
  player="${CYCLE_PLAYER_PREFIX}-${i}"

  # Recruit a mock player (echo mode is fine — we want churn, not behavior).
  # Failures here are non-fatal — the daemon may transiently reject under
  # load and we want the harness to keep churning to amplify the leak.
  ct recruit "$player" \
      --ensemble "$ENSEMBLE_NAME" \
      --agent mock \
      --mode echo \
      --part "heap-snapshot-336 probe ${i}" \
      >/dev/null 2>&1 || true

  # Immediately destroy — short-lived workflows compound the visibility-
  # iterator pressure across resolve/orphan-scan paths.
  ct destroy "$player" \
      --ensemble "$ENSEMBLE_NAME" \
      >/dev/null 2>&1 || true

  if [ "$INTERVAL_SEC" -gt 0 ]; then
    sleep "$INTERVAL_SEC"
  fi

  # Progress + RSS snapshot every 50 cycles. The `daemon stats` CLI
  # (added by #343) exposes the daemon's current memory without
  # requiring a debugger attach.
  if [ $((i % 50)) -eq 0 ]; then
    elapsed=$(( $(date +%s) - START_TS ))
    log "cycle=$i  elapsed=${elapsed}s"
    ct daemon stats 2>/dev/null | grep -E '^(rss|heapUsed|uptime)' || true
  fi

  # Mid-run checkpoint.
  if [ "$i" -eq "$((CYCLES / 2))" ]; then
    checkpoint "$i"
  fi
done

# ── Final checkpoint ───────────────────────────────────────────────────
log ""
log "All $CYCLES cycles complete."
log "Final daemon stats:"
ct daemon stats || true

checkpoint "$CYCLES"

log ""
log "Done. Three snapshots expected at $OUT_DIR/snapshot-{0,$((CYCLES / 2)),$CYCLES}.heapsnapshot"
log ""
log "Next steps:"
log "  1. Open all three in Chrome DevTools → Memory → load profile"
log "  2. Use 'Comparison' view, select cycle-0 as baseline"
log "  3. Sort retained size column descending"
log "  4. Group by constructor; look for grpc-js / @temporalio / Connection growth"
log ""
log "Report findings back to #336 with the top 5 retainers by retained-size delta."
