/**
 * Unit tests for `classifyTemporalServerOwnership` / `isOwnedLocalTemporal`
 * (#907 Problem A).
 *
 * The *namespace* is agent-tempo's unit of ownership; the Temporal *server* is
 * not. `down --destroy` must never kill a server it doesn't own — a shared
 * local server (hosting other namespaces), a remote server, or Temporal Cloud.
 * The detector returns `owned: false` for any of: API key configured, TLS
 * cert/key configured, or a non-loopback address host. `--kill-shared-temporal`
 * (the cross-PROFILE opt-in) does NOT override this categorical refusal — the
 * gate lives in `down()` ahead of the cross-profile guard.
 *
 * Pure function over `Config` — no env, no home dir, no process spawning.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyTemporalServerOwnership,
  isOwnedLocalTemporal,
  type Config,
} from '../../src/config';

/** Minimal Config — only the Temporal connection fields are read. */
function cfg(over: Partial<Config> = {}): Config {
  return {
    temporalAddress: 'localhost:7233',
    temporalNamespace: 'default',
    defaultAgent: 'claude',
    taskQueue: 'agent-tempo',
    ensemble: 'default',
    ...over,
  } as Config;
}

describe('classifyTemporalServerOwnership — owned local servers (#907)', () => {
  it('owns a bare localhost dev server', () => {
    expect(classifyTemporalServerOwnership(cfg({ temporalAddress: 'localhost:7233' }))).toEqual({
      owned: true,
    });
    expect(isOwnedLocalTemporal(cfg({ temporalAddress: 'localhost:7233' }))).toBe(true);
  });

  it('owns 127.0.0.1 and ::1 (loopback) and a bracketed IPv6 loopback', () => {
    expect(isOwnedLocalTemporal(cfg({ temporalAddress: '127.0.0.1:7233' }))).toBe(true);
    expect(isOwnedLocalTemporal(cfg({ temporalAddress: '::1' }))).toBe(true);
    expect(isOwnedLocalTemporal(cfg({ temporalAddress: '[::1]:7233' }))).toBe(true);
  });

  it('treats a bare :port (empty host) as loopback, matching the up auto-start probe', () => {
    expect(isOwnedLocalTemporal(cfg({ temporalAddress: ':7233' }))).toBe(true);
  });
});

describe('classifyTemporalServerOwnership — NOT owned (#907)', () => {
  it('refuses when an API key is configured (Temporal Cloud / authenticated remote)', () => {
    const r = classifyTemporalServerOwnership(
      cfg({ temporalAddress: 'my-ns.a1b2c.tmprl.cloud:7233', temporalApiKey: 'sk-test' }),
    );
    expect(r).toEqual({ owned: false, reason: 'api-key', host: 'my-ns.a1b2c.tmprl.cloud' });
    expect(isOwnedLocalTemporal(cfg({ temporalApiKey: 'sk-test' }))).toBe(false);
  });

  it('refuses when a TLS cert OR key is configured', () => {
    expect(
      classifyTemporalServerOwnership(cfg({ temporalTlsCertPath: '/etc/tls/client.pem' })).owned,
    ).toBe(false);
    expect(
      classifyTemporalServerOwnership(cfg({ temporalTlsKeyPath: '/etc/tls/client.key' })).owned,
    ).toBe(false);
    expect(
      classifyTemporalServerOwnership(cfg({ temporalTlsCertPath: '/x', temporalTlsKeyPath: '/y' }))
        .reason === 'tls',
    ).toBe(true);
  });

  it('refuses a non-loopback host even without API key / TLS (shared/remote server)', () => {
    const r = classifyTemporalServerOwnership(cfg({ temporalAddress: '10.0.0.5:7233' }));
    expect(r).toEqual({ owned: false, reason: 'remote', host: '10.0.0.5' });
    expect(isOwnedLocalTemporal(cfg({ temporalAddress: 'temporal.internal:7233' }))).toBe(false);
  });

  it('refuses a .tmprl.cloud address (Temporal Cloud) on the host check alone', () => {
    expect(
      isOwnedLocalTemporal(cfg({ temporalAddress: 'my-ns.a1b2c.tmprl.cloud:7233' })),
    ).toBe(false);
  });

  it('API key takes precedence over the host reason in the classification', () => {
    // Even a localhost address is not-owned once an API key is present — the
    // operator is clearly pointing at an authenticated endpoint.
    const r = classifyTemporalServerOwnership(
      cfg({ temporalAddress: 'localhost:7233', temporalApiKey: 'k' }),
    );
    expect(r).toEqual({ owned: false, reason: 'api-key', host: 'localhost' });
  });
});
