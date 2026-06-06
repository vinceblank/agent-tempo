/**
 * Unit tests for config secret-masking (#684) — `maskSecret` + `isSecretKey`
 * (src/cli/config-command.ts). The invariant that matters: a displayed secret
 * NEVER contains the full raw value (terminal scrollback / screen-share / logs).
 */
import { describe, it, expect } from 'vitest';
import { maskSecret } from '../../src/cli/config-command';
import { isSecretKey } from '../../src/utils/secrets';

describe('maskSecret', () => {
  it('renders "(not set)" for empty / undefined / null', () => {
    expect(maskSecret('')).toBe('(not set)');
    expect(maskSecret(undefined)).toBe('(not set)');
    expect(maskSecret(null)).toBe('(not set)');
  });

  it('shows a short non-sensitive prefix + masked tail + char count for a long secret', () => {
    const key = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const out = maskSecret(key);
    expect(out).toContain('sk-ant'); // 6-char prefix (provider tag, non-sensitive)
    expect(out).toContain('•');       // masked tail
    expect(out).toContain(`set, ${key.length} chars`);
  });

  it('NEVER emits the full secret (the core invariant)', () => {
    for (const key of [
      'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      'short',                // < 8 chars → no prefix at all
      'eightchr',             // exactly 8 → 3-char prefix
      'twelvechars0',         // exactly 12 → 6-char prefix
      'a'.repeat(200),
    ]) {
      expect(maskSecret(key), `must not leak "${key}"`).not.toContain(key);
    }
  });

  it('reveals NO prefix for short secrets (< 8 chars)', () => {
    const out = maskSecret('abcdef'); // 6 chars
    expect(out).toBe('•••• (set, 6 chars)');
    expect(out).not.toContain('abc');
  });
});

describe('isSecretKey', () => {
  it('flags credential-bearing fields', () => {
    for (const k of ['temporalApiKey', 'httpToken', 'readToken', 'adminToken', 'ANTHROPIC_API_KEY', 'somePassword', 'mySecret']) {
      expect(isSecretKey(k), `${k} should be secret`).toBe(true);
    }
  });

  it('does NOT flag *Path fields (file locations, not secrets) or plain values', () => {
    for (const k of ['temporalTlsKeyPath', 'temporalTlsCertPath', 'temporalAddress', 'temporalNamespace', 'defaultAgent', 'claudeBin']) {
      expect(isSecretKey(k), `${k} should NOT be secret`).toBe(false);
    }
  });
});
