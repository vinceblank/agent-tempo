/**
 * Unit tests for the claude-code-headless adapter pre-flight probes.
 *
 * Pure parser tests against captured fixtures (no subprocess spawn). The
 * `parseAuthStatusOutput` helper is the only side-effect-free surface that
 * matters for CI — the spawnSync wrappers around `claude --version` and
 * `claude auth status` are exercised end-to-end by the manual smoke test
 * + the recruit-tool integration tests (PR-2 layers in a fake-binary
 * coverage path via the spawn helper unit tests).
 *
 * Issue #520 PR-1 — covers the recruit-time pre-flight contract.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseAuthStatusOutput } from '../../../src/adapters/claude-code-headless/pre-flight';

const FIXTURES_DIR = path.resolve(
  __dirname,
  '..',
  'fixtures',
  'claude-code-headless',
);

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

describe('parseAuthStatusOutput', () => {
  it('returns loggedIn=true with auth method for a subscription session', () => {
    const stdout = readFixture('auth-status-logged-in-subscription.json');
    const result = parseAuthStatusOutput(stdout, 0);
    expect(result.loggedIn).toBe(true);
    expect(result.authMethod).toBe('claude.ai');
    expect(result.apiProvider).toBe('firstParty');
    expect(result.error).toBeUndefined();
  });

  it('returns loggedIn=true with auth-token method for a long-lived OAuth (CI) session', () => {
    const stdout = readFixture('auth-status-logged-in-api-token.json');
    const result = parseAuthStatusOutput(stdout, 0);
    expect(result.loggedIn).toBe(true);
    expect(result.authMethod).toBe('api-token');
  });

  it('returns loggedIn=false with operator-actionable error for a logged-out session', () => {
    const stdout = readFixture('auth-status-logged-out.json');
    const result = parseAuthStatusOutput(stdout, 0);
    expect(result.loggedIn).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/not logged in/i);
    expect(result.error).toMatch(/auth login/);
    // Mentions claude-api as a fallback so operators have a clean
    // alternative path without re-reading docs.
    expect(result.error).toMatch(/claude-api/);
  });

  it('returns loggedIn=false on empty stdout', () => {
    const result = parseAuthStatusOutput('', 0);
    expect(result.loggedIn).toBe(false);
    expect(result.error).toMatch(/no output/i);
  });

  it('returns loggedIn=false on malformed JSON with the broken bytes in the error', () => {
    const result = parseAuthStatusOutput('this is not json', 0);
    expect(result.loggedIn).toBe(false);
    expect(result.error).toMatch(/parse/i);
    expect(result.error).toMatch(/this is not json/);
  });

  it('returns loggedIn=false on JSON with non-object root (e.g. an array)', () => {
    const result = parseAuthStatusOutput('["not", "an", "object"]', 0);
    expect(result.loggedIn).toBe(false);
    expect(result.error).toMatch(/non-object/i);
  });

  it('uses the provided binary name in the error string for actionability', () => {
    const result = parseAuthStatusOutput('', 0, 'claude-test-stub');
    expect(result.error).toMatch(/claude-test-stub/);
  });

  it('treats `loggedIn: "true"` (string, not boolean) as logged out — strict boolean check', () => {
    // Defense-in-depth: future CLI versions changing the field shape
    // shouldn't be silently mis-parsed as logged in.
    const result = parseAuthStatusOutput('{"loggedIn": "true"}', 0);
    expect(result.loggedIn).toBe(false);
  });

  it('handles `{"loggedIn": true}` with no optional fields (minimal valid envelope)', () => {
    // Per QA Nit 4 from PR-1's review: confirm the parser doesn't require
    // authMethod/apiProvider/email/etc — a minimal envelope from a future
    // CLI version (or a test stub) must still resolve as logged-in.
    const result = parseAuthStatusOutput('{"loggedIn": true}', 0);
    expect(result.loggedIn).toBe(true);
    expect(result.authMethod).toBeUndefined();
    expect(result.apiProvider).toBeUndefined();
    expect(result.error).toBeUndefined();
  });
});
