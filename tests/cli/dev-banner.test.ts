/**
 * Unit tests for the `[DEV MODE]` banner formatter (ADR 0014 §5.4 —
 * gate 4 of production safety). Coverage:
 *   - Banner format matches the locked design (`[DEV MODE] using <home> · port N · namespace X · queue Y`).
 *   - `prettyPath()` collapses `<homedir>/foo` to `~/foo` for human-readable output.
 *   - `prettyPath()` falls back to the absolute path when not under home.
 *   - `devBannerOrEmpty()` returns the empty string when not in dev mode
 *     (negative case — required by architect's gate-1 contract).
 *   - Dev-mode banner does NOT bleed production defaults into its values.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROD_DEFAULTS_FOR_TESTS,
  devBannerOrEmpty,
  formatDevBanner,
  prettyPath,
} from '../../src/cli/dev-banner';
import {
  DEV_DAEMON_PORT,
  DEV_TASK_QUEUE,
  DEV_TEMPORAL_NAMESPACE,
  ENV,
} from '../../src/config';

/** Strip ANSI escape sequences so format assertions are TTY-independent. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('prettyPath', () => {
  it('collapses paths under homedir to ~/...', () => {
    expect(prettyPath('/home/alice/.claude-tempo-dev', '/home/alice')).toBe('~/.claude-tempo-dev');
  });

  it('returns "~" when the path is exactly homedir', () => {
    expect(prettyPath('/home/alice', '/home/alice')).toBe('~');
  });

  it('falls back to absolute when path is not under home', () => {
    expect(prettyPath('/tmp/scratch', '/home/alice')).toBe('/tmp/scratch');
  });

  it('handles Windows-style separators', () => {
    expect(prettyPath('C:\\Users\\alice\\.claude-tempo-dev', 'C:\\Users\\alice'))
      .toBe('~/.claude-tempo-dev');
  });

  it('handles a forward-slash home with backslash path (cross-style tolerance)', () => {
    // Some env-var setups use forward slashes even on Windows; the formatter
    // should tolerate the mixed-separator case rather than render an
    // unstripped absolute path.
    expect(prettyPath('C:/Users/alice/.claude-tempo-dev', 'C:/Users/alice'))
      .toBe('~/.claude-tempo-dev');
  });
});

describe('formatDevBanner', () => {
  it('matches the locked single-line format from ADR 0014 §5.4', () => {
    const banner = stripAnsi(
      formatDevBanner({
        home: '/home/alice/.claude-tempo-dev',
        homedirOverride: '/home/alice',
      }),
    );
    expect(banner).toBe(
      `[DEV MODE] using ~/.claude-tempo-dev · port ${DEV_DAEMON_PORT} ` +
      `· namespace ${DEV_TEMPORAL_NAMESPACE} · queue ${DEV_TASK_QUEUE}`,
    );
  });

  it('uses dev profile defaults when no inputs are passed', () => {
    // No `home:` override ⇒ uses the live `CLAUDE_TEMPO_HOME` constant
    // (which is `~/.claude-tempo/` here because dev mode wasn't set when
    // config.ts loaded). Either way the rest of the values must be the
    // dev defaults — we don't want production values bleeding into the
    // banner via stale closures.
    const banner = stripAnsi(formatDevBanner());
    expect(banner).toContain(`port ${DEV_DAEMON_PORT}`);
    expect(banner).toContain(`namespace ${DEV_TEMPORAL_NAMESPACE}`);
    expect(banner).toContain(`queue ${DEV_TASK_QUEUE}`);
    // Sanity: production constants must NOT appear as the resolved value
    // for that field. Match end-of-string OR a separator character so the
    // assertion isn't fooled by `claude-tempo` being a substring of
    // `claude-tempo-dev` (the dev task queue).
    const sep = '(?:[\\s·]|$)';
    expect(banner).not.toMatch(new RegExp(`port ${PROD_DEFAULTS_FOR_TESTS.port}${sep}`));
    expect(banner).not.toMatch(new RegExp(`namespace ${PROD_DEFAULTS_FOR_TESTS.namespace}${sep}`));
    expect(banner).not.toMatch(new RegExp(`queue ${PROD_DEFAULTS_FOR_TESTS.taskQueue}${sep}`));
  });

  it('renders an absolute home path verbatim when not under homedir', () => {
    const banner = stripAnsi(
      formatDevBanner({
        home: '/tmp/scratch',
        homedirOverride: '/home/alice',
      }),
    );
    expect(banner).toContain('using /tmp/scratch ');
  });
});

describe('devBannerOrEmpty', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV.DEV_MODE];
  });

  afterEach(() => {
    if (saved == null) delete process.env[ENV.DEV_MODE];
    else process.env[ENV.DEV_MODE] = saved;
  });

  it('returns empty string when dev mode is off (gate-1 negative case)', () => {
    delete process.env[ENV.DEV_MODE];
    expect(devBannerOrEmpty()).toBe('');
  });

  it('returns the formatted banner when dev mode is on', () => {
    process.env[ENV.DEV_MODE] = '1';
    expect(stripAnsi(devBannerOrEmpty())).toContain('[DEV MODE]');
  });
});
