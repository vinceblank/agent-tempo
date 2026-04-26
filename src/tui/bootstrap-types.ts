/**
 * Bootstrap result contract — produced by `src/cli/startup.ts` and consumed
 * by {@link HomeView}. This file is the single source of truth so both
 * sides can be implemented independently.
 */

import type { EnsembleSummary } from '../client';

/** Discrete boot steps — used for progress indicators on slow boots. */
export type BootstrapStep =
  | 'tempo-cli'
  | 'temporal-server'
  | 'daemon'
  | 'mcp'
  | 'global-maestro'
  | 'ensembles-and-orphans';

export interface BootstrapStepOutcome {
  /** `true` when the step completed without errors. */
  ok: boolean;
  /** Wall-clock duration of the step in milliseconds. */
  durationMs: number;
  /** Error message on failure; undefined on success. */
  error?: string;
}

export interface BootstrapBadges {
  /** Orphan sessions on this host that can be restored. */
  orphanCount: number;
  /** Surfaced when a user-visible newer version is available. */
  outdatedVersion?: {
    latest: string;
    severity: 'major' | 'minor';
  };
  /** Recent daemon-log ERROR lines; undefined when the tail is clean. */
  daemonLogErrors?: {
    count: number;
    /** Up to 3 most recent lines. */
    sample: string[];
    logPath: string;
  };
}

/**
 * Pre-computed boot state handed to {@link HomeView} so the first paint
 * renders instantly. The same snapshot drives the "boot took Xms" debug
 * line and the slow-boot progress indicator.
 */
export interface BootstrapResult {
  durationMs: number;
  steps: Record<BootstrapStep, BootstrapStepOutcome>;
  badges: BootstrapBadges;
  ensembles: EnsembleSummary[];
  cwd: string;
  /** Absolute path of the nearest git root, or `null` when not in a git dir. */
  cwdGitRoot: string | null;
}
