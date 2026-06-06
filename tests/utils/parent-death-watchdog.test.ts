/**
 * Unit test for the #672 ppid-poll gate (src/utils/parent-death-watchdog.ts).
 *
 * The fix: installParentDeathWatchdog ALWAYS installs the universally-correct
 * stdin-EOF signal, but installs the ppid-poll ONLY when the transient-spawner
 * flag (ENV.NO_PPID_WATCHDOG) is ABSENT. shouldInstallPpidPoll is the pure gate
 * decision — flag-set → false (skip ppid-poll, the detached-from-transient-CLI
 * conductor case), flag-unset → true (keep it, the #604 daemon anti-leak case).
 */
import { describe, it, expect } from 'vitest';
import { shouldInstallPpidPoll } from '../../src/utils/parent-death-watchdog';
import { ENV } from '../../src/config';

describe('shouldInstallPpidPoll (#672 ppid-poll gate)', () => {
  it('SKIPS the ppid-poll when the transient-spawner flag is set ("1")', () => {
    expect(shouldInstallPpidPoll({ [ENV.NO_PPID_WATCHDOG]: '1' })).toBe(false);
  });

  it('KEEPS the ppid-poll when the flag is absent (daemon-recruit / in-editor — #604)', () => {
    expect(shouldInstallPpidPoll({})).toBe(true);
  });

  it('KEEPS the ppid-poll for any non-"1" value (only an explicit "1" suppresses)', () => {
    expect(shouldInstallPpidPoll({ [ENV.NO_PPID_WATCHDOG]: '' })).toBe(true);
    expect(shouldInstallPpidPoll({ [ENV.NO_PPID_WATCHDOG]: '0' })).toBe(true);
    expect(shouldInstallPpidPoll({ [ENV.NO_PPID_WATCHDOG]: 'true' })).toBe(true);
  });
});
