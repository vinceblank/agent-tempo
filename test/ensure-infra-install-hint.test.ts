/**
 * Unit tests for the `daemon install` nudge added to `src/cli/ensure-infra.ts`
 * (architect ruling §5 — folded from the original PR-4 into PR-C). Pure
 * injectable-deps tests — no filesystem, no Temporal, no real daemon.
 */
import { expect } from 'chai';
import { isDaemonSupervisionInstalled, printInstallHintIfNeeded } from '../src/cli/ensure-infra';

describe('isDaemonSupervisionInstalled', function () {
  it('linux: true when the systemd --user unit file exists', function () {
    const result = isDaemonSupervisionInstalled({
      platform: 'linux',
      existsSync: (p) => p.includes('systemd') && p.endsWith('agent-tempo.service'),
    });
    expect(result).to.be.true;
  });

  it('linux: false when the unit file is absent', function () {
    const result = isDaemonSupervisionInstalled({ platform: 'linux', existsSync: () => false });
    expect(result).to.be.false;
  });

  it('darwin: true when the launchd plist exists', function () {
    const result = isDaemonSupervisionInstalled({
      platform: 'darwin',
      existsSync: (p) => p.includes('LaunchAgents') && p.endsWith('com.agent.tempo.plist'),
    });
    expect(result).to.be.true;
  });

  it('darwin: false when the plist is absent', function () {
    const result = isDaemonSupervisionInstalled({ platform: 'darwin', existsSync: () => false });
    expect(result).to.be.false;
  });

  it('win32: delegates to the injected schtasks query', function () {
    expect(isDaemonSupervisionInstalled({ platform: 'win32', querySchtasks: () => true })).to.be.true;
    expect(isDaemonSupervisionInstalled({ platform: 'win32', querySchtasks: () => false })).to.be.false;
  });

  it('never throws — a probe that throws degrades to false', function () {
    const result = isDaemonSupervisionInstalled({
      platform: 'linux',
      existsSync: () => { throw new Error('boom'); },
    });
    expect(result).to.be.false;
  });

  it('unknown platform: false (no probe defined)', function () {
    expect(isDaemonSupervisionInstalled({ platform: 'aix' as NodeJS.Platform })).to.be.false;
  });
});

describe('printInstallHintIfNeeded', function () {
  it('does nothing in dev mode, even if unsupervised', function () {
    let warned = false;
    let markerWritten = false;
    printInstallHintIfNeeded({
      isDevMode: () => true,
      existsSync: () => false,
      isDaemonSupervisionInstalled: () => false,
      warn: () => { warned = true; },
      writeMarker: () => { markerWritten = true; },
    });
    expect(warned).to.be.false;
    expect(markerWritten).to.be.false;
  });

  it('does nothing when the hint marker already exists', function () {
    let warned = false;
    printInstallHintIfNeeded({
      isDevMode: () => false,
      existsSync: () => true, // marker present
      isDaemonSupervisionInstalled: () => false,
      warn: () => { warned = true; },
    });
    expect(warned).to.be.false;
  });

  it('does nothing when supervision is already installed', function () {
    let warned = false;
    printInstallHintIfNeeded({
      isDevMode: () => false,
      existsSync: () => false,
      isDaemonSupervisionInstalled: () => true,
      warn: () => { warned = true; },
    });
    expect(warned).to.be.false;
  });

  it('warns and writes the marker when unsupervised, non-dev, no marker yet', function () {
    let warned = false;
    let markerWritten = false;
    printInstallHintIfNeeded({
      isDevMode: () => false,
      existsSync: () => false,
      isDaemonSupervisionInstalled: () => false,
      warn: (msg) => { warned = true; expect(msg).to.include('daemon install'); },
      writeMarker: () => { markerWritten = true; },
    });
    expect(warned).to.be.true;
    expect(markerWritten).to.be.true;
  });

  it('still warns even if writing the marker fails (never throws)', function () {
    let warned = false;
    expect(() => printInstallHintIfNeeded({
      isDevMode: () => false,
      existsSync: () => false,
      isDaemonSupervisionInstalled: () => false,
      warn: () => { warned = true; },
      writeMarker: () => { throw new Error('disk full'); },
    })).to.not.throw();
    expect(warned).to.be.true;
  });
});
