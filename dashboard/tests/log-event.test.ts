/**
 * `logEvent` wrapper — formatting + level gating.
 *
 * Lock the on-the-wire format because the conductor's autonomous
 * validation script regex-matches `[claude-tempo:dashboard]` to
 * verify state without parsing the DOM. Drift here breaks every
 * downstream check.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logEvent } from '../src/lib/log';

describe('logEvent format', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    window.localStorage.removeItem('claudeTempoDebug');
    // Reset URL so per-test ?debug=1 doesn't leak.
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it('emits `[claude-tempo:dashboard] <action>` with no kvs', () => {
    logEvent('app-mounted');
    expect(infoSpy).toHaveBeenCalledWith('[claude-tempo:dashboard] app-mounted');
  });

  it('emits `[claude-tempo:dashboard] <action> key=value` with kvs', () => {
    logEvent('cue-sent', { target: 'tempo-eng', textLen: 42 });
    expect(infoSpy).toHaveBeenCalledWith(
      '[claude-tempo:dashboard] cue-sent target="tempo-eng" textLen=42',
    );
  });

  it('JSON.stringifies string values so they keep their quotes', () => {
    // Values with internal quotes/colons/spaces must not break the format.
    logEvent('error', { reason: 'timeout: 30s' });
    expect(infoSpy).toHaveBeenCalledWith(
      '[claude-tempo:dashboard] error reason="timeout: 30s"',
    );
  });

  it('routes by level — info, warn, error to their respective console methods', () => {
    logEvent('warn-evt', { x: 1 }, 'warn');
    logEvent('err-evt', { y: 2 }, 'error');
    expect(warnSpy).toHaveBeenCalledWith('[claude-tempo:dashboard] warn-evt x=1');
    expect(errorSpy).toHaveBeenCalledWith('[claude-tempo:dashboard] err-evt y=2');
  });

  it('debug level is suppressed by default', () => {
    logEvent('verbose-step', { k: 'v' }, 'debug');
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('debug fires when `?debug=1` is in the URL', () => {
    window.history.replaceState({}, '', '/?debug=1');
    logEvent('verbose-step', { k: 'v' }, 'debug');
    expect(debugSpy).toHaveBeenCalledWith('[claude-tempo:dashboard] verbose-step k="v"');
  });

  it('debug fires when `localStorage.claudeTempoDebug === "true"`', () => {
    window.localStorage.setItem('claudeTempoDebug', 'true');
    logEvent('verbose-step', { k: 'v' }, 'debug');
    expect(debugSpy).toHaveBeenCalledWith('[claude-tempo:dashboard] verbose-step k="v"');
  });

  it('debug stays suppressed when localStorage holds an unrelated value', () => {
    window.localStorage.setItem('claudeTempoDebug', 'yes');
    logEvent('verbose-step', { k: 'v' }, 'debug');
    expect(debugSpy).not.toHaveBeenCalled();
  });
});
