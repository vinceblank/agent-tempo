/**
 * Shared constants used by every fixture file. Kept separate so a single
 * boot-epoch change updates the whole registry atomically.
 */

/**
 * Synthetic boot epoch — the `<bootEpoch>` half of every fixture's
 * `<bootEpoch>:<seq>` event-id token. Picked once and frozen so every
 * fixture's events sort consistently.
 */
export const FIXTURE_BOOT_EPOCH = '1735000000000';
