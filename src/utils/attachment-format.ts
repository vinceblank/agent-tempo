/**
 * Shared attachment-info display formatter.
 *
 * Renders an {@link AttachmentInfo} snapshot into an array of plain strings
 * suitable for either stdout (`agent-tempo attachment-info`) or the TUI
 * overlay (`/attachment-info`). Pure — no Temporal, no stdout, no ANSI
 * colors — so unit tests can assert exact lines without booting a client.
 *
 * Lives in `src/utils/` (not `src/cli/`) because both the CLI and TUI
 * consume it; #264 carved it out of `src/cli/commands.ts` to eliminate the
 * cross-surface drift where only the CLI rendered heartbeat age.
 *
 * `now` is injectable so tests can freeze the clock and assert the
 * heartbeat-age string deterministically. Heartbeat age uses
 * {@link formatDurationMs} (same helper the scheduler output uses) suffixed
 * with "ago" — e.g. `5s ago`, `2m ago`. Clock-skew (heartbeat timestamp in
 * the future) renders as `just now`; a malformed timestamp renders as
 * `unknown`.
 */
import type { AttachmentInfo } from '../types';
import { formatDurationMs } from './duration';

export function formatAttachmentInfoForDisplay(
  name: string,
  info: AttachmentInfo,
  now: number = Date.now(),
): string[] {
  const lines: string[] = [
    `${name} — phase: ${info.phase}`,
    `  in-flight: ${info.inFlightCount}`,
  ];
  if (info.currentAttachment) {
    const a = info.currentAttachment;
    lines.push(`  attached on: ${a.hostname} (adapter: ${a.adapterId}/${a.adapterClass})`);
    lines.push(`  attachmentId: ${a.attachmentId}`);
    lines.push(`  lease expires: ${a.expiresAt}`);
    lines.push(`  heartbeat: ${formatHeartbeatAge(a.lastHeartbeatAt, now)}`);
  }
  if (info.preferredHost) lines.push(`  preferred host: ${info.preferredHost}`);
  if (info.processingSince) lines.push(`  processing since: ${info.processingSince}`);
  return lines;
}

export function formatHeartbeatAge(lastHeartbeatAt: string, now: number): string {
  const then = Date.parse(lastHeartbeatAt);
  if (!Number.isFinite(then)) return 'unknown';
  const ageMs = now - then;
  if (ageMs < 0) return 'just now'; // adapter clock ran ahead of ours — degrade gracefully
  return `${formatDurationMs(ageMs)} ago`;
}
