/**
 * Unit tests for PR-E daemon config — `DaemonConfigSchema`, `matchEnsembleGlob`,
 * `isEnsembleAllowed`. No filesystem, no Temporal. Pure schema + string math.
 */
import { expect } from 'chai';
import { DaemonConfigSchema, matchEnsembleGlob, isEnsembleAllowed } from '../src/config';

describe('DaemonConfigSchema', function () {
  it('fills defaults from an empty object', function () {
    const result = DaemonConfigSchema.parse({});
    expect(result.restorePolicy).to.equal('prompt');
    expect(result.autoRestoreMaxAgeHours).to.equal(24);
    expect(result.autoRestoreEnsembles).to.deep.equal([]);
    expect(result.cleanupPolicy.detachedMaxAgeDays).to.equal(7);
    expect(result.cleanupPolicy.destroyedMaxAgeDays).to.equal(30);
  });

  it('accepts partial config and merges defaults per-field', function () {
    const result = DaemonConfigSchema.parse({ restorePolicy: 'auto' });
    expect(result.restorePolicy).to.equal('auto');
    expect(result.autoRestoreMaxAgeHours).to.equal(24); // default
    expect(result.cleanupPolicy.detachedMaxAgeDays).to.equal(7); // default
  });

  it('rejects invalid restorePolicy', function () {
    expect(() => DaemonConfigSchema.parse({ restorePolicy: 'sometimes' })).to.throw();
  });

  it('accepts user-overridden cleanupPolicy fields', function () {
    const result = DaemonConfigSchema.parse({
      cleanupPolicy: { detachedMaxAgeDays: 14, destroyedMaxAgeDays: 90 },
    });
    expect(result.cleanupPolicy.detachedMaxAgeDays).to.equal(14);
    expect(result.cleanupPolicy.destroyedMaxAgeDays).to.equal(90);
  });

  it('rejects non-positive retention days', function () {
    expect(() => DaemonConfigSchema.parse({
      cleanupPolicy: { detachedMaxAgeDays: 0, destroyedMaxAgeDays: 30 },
    })).to.throw();
    expect(() => DaemonConfigSchema.parse({
      cleanupPolicy: { detachedMaxAgeDays: -1, destroyedMaxAgeDays: 30 },
    })).to.throw();
  });
});

describe('matchEnsembleGlob (simple prefix match, §8 answer 5)', function () {
  it('exact match without trailing *', function () {
    expect(matchEnsembleGlob('my-team', 'my-team')).to.be.true;
    expect(matchEnsembleGlob('other', 'my-team')).to.be.false;
  });

  it('prefix match with trailing *', function () {
    expect(matchEnsembleGlob('my-team-prod', 'my-*')).to.be.true;
    expect(matchEnsembleGlob('my-', 'my-*')).to.be.true;
    expect(matchEnsembleGlob('other-my-team', 'my-*')).to.be.false;
  });

  it('pattern with only * matches any ensemble', function () {
    expect(matchEnsembleGlob('anything', '*')).to.be.true;
    expect(matchEnsembleGlob('', '*')).to.be.true;
  });
});

describe('isEnsembleAllowed', function () {
  it('empty allowlist → allow all', function () {
    expect(isEnsembleAllowed('any-ensemble', [])).to.be.true;
  });

  it('allow when any pattern matches', function () {
    expect(isEnsembleAllowed('my-team-prod', ['my-*', 'other'])).to.be.true;
    expect(isEnsembleAllowed('other', ['my-*', 'other'])).to.be.true;
  });

  it('deny when no pattern matches', function () {
    expect(isEnsembleAllowed('random', ['my-*', 'other'])).to.be.false;
  });
});
