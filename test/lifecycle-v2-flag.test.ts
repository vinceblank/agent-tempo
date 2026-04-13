/**
 * Tests for the `CLAUDE_TEMPO_LIFECYCLE_V2` feature flag helper.
 *
 * PR-C commit 1 ships the flag read alongside its consumer surface (adapters in
 * commits 2-3). Semantic: default ON; `0`/`false`/`off`/`no` disables for rollback.
 */
import { expect } from 'chai';
import { ENV, lifecycleV2Enabled } from '../src/config';

describe('CLAUDE_TEMPO_LIFECYCLE_V2 flag', () => {
  it('defaults to true when the env var is unset', () => {
    expect(lifecycleV2Enabled({})).to.equal(true);
  });

  it('defaults to true when the env var is an empty string', () => {
    expect(lifecycleV2Enabled({ [ENV.LIFECYCLE_V2]: '' })).to.equal(true);
  });

  it('treats `1` / `true` / `on` / `yes` as enabled (even though default is already on)', () => {
    for (const v of ['1', 'true', 'TRUE', 'on', 'ON', 'yes']) {
      expect(lifecycleV2Enabled({ [ENV.LIFECYCLE_V2]: v })).to.equal(true, `value=${v}`);
    }
  });

  it('treats `0` / `false` / `off` / `no` as disabled (case-insensitive, whitespace-tolerant)', () => {
    for (const v of ['0', 'false', 'FALSE', ' off ', 'no', 'NO']) {
      expect(lifecycleV2Enabled({ [ENV.LIFECYCLE_V2]: v })).to.equal(false, `value=${v}`);
    }
  });

  it('treats any non-falsy string as enabled (lean toward staying on during rollbacks)', () => {
    // Unknown values stay on so a typo doesn't silently disable the flag.
    expect(lifecycleV2Enabled({ [ENV.LIFECYCLE_V2]: 'maybe' })).to.equal(true);
    expect(lifecycleV2Enabled({ [ENV.LIFECYCLE_V2]: 'garbage' })).to.equal(true);
  });
});
