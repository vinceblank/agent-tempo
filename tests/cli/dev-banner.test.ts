/**
 * Unit tests for the `[DEV MODE]` banner formatter (ADR 0014 §5.4 —
 * gate 4 of production safety). Coverage:
 *   - Banner format matches the locked design (`[DEV MODE] using <home> · port N · namespace X · queue Y`).
 *   - `prettyPath()` collapses `<homedir>/foo` to `~/foo` for human-readable output.
 *   - `prettyPath()` falls back to the absolute path when not under home.
 *   - `devBannerOrEmpty()` returns the empty string when not in dev mode
 *     (negative case — required by architect's gate-1 contract).
 *   - Dev-mode banner does NOT bleed production defaults into its values.
 *   - Banner annotates the namespace source when not 'default' (#423 PR-A).
 *   - `resolveDevBannerInputs` reads from `getConfigWithSources` so the
 *     banner reflects what the daemon ACTUALLY connects to, not the
 *     dev profile's hardcoded constants.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROD_DEFAULTS_FOR_TESTS,
  devBannerOrEmpty,
  formatDevBanner,
  prettyPath,
  resolveDevBannerInputs,
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
    expect(prettyPath('/home/alice/.agent-tempo-dev', '/home/alice')).toBe('~/.agent-tempo-dev');
  });

  it('returns "~" when the path is exactly homedir', () => {
    expect(prettyPath('/home/alice', '/home/alice')).toBe('~');
  });

  it('falls back to absolute when path is not under home', () => {
    expect(prettyPath('/tmp/scratch', '/home/alice')).toBe('/tmp/scratch');
  });

  it('handles Windows-style separators', () => {
    expect(prettyPath('C:\\Users\\alice\\.agent-tempo-dev', 'C:\\Users\\alice'))
      .toBe('~/.agent-tempo-dev');
  });

  it('handles a forward-slash home with backslash path (cross-style tolerance)', () => {
    // Some env-var setups use forward slashes even on Windows; the formatter
    // should tolerate the mixed-separator case rather than render an
    // unstripped absolute path.
    expect(prettyPath('C:/Users/alice/.agent-tempo-dev', 'C:/Users/alice'))
      .toBe('~/.agent-tempo-dev');
  });
});

describe('formatDevBanner', () => {
  it('matches the locked single-line format from ADR 0014 §5.4', () => {
    const banner = stripAnsi(
      formatDevBanner({
        home: '/home/alice/.agent-tempo-dev',
        homedirOverride: '/home/alice',
      }),
    );
    expect(banner).toBe(
      `[DEV MODE] using ~/.agent-tempo-dev · port ${DEV_DAEMON_PORT} ` +
      `· namespace ${DEV_TEMPORAL_NAMESPACE} · queue ${DEV_TASK_QUEUE}`,
    );
  });

  it('uses dev profile defaults when no inputs are passed', () => {
    // No `home:` override ⇒ uses the live `AGENT_TEMPO_HOME` constant
    // (which is `~/.agent-tempo/` here because dev mode wasn't set when
    // config.ts loaded). Either way the rest of the values must be the
    // dev defaults — we don't want production values bleeding into the
    // banner via stale closures.
    const banner = stripAnsi(formatDevBanner());
    expect(banner).toContain(`port ${DEV_DAEMON_PORT}`);
    expect(banner).toContain(`namespace ${DEV_TEMPORAL_NAMESPACE}`);
    expect(banner).toContain(`queue ${DEV_TASK_QUEUE}`);
    // Sanity: production constants must NOT appear as the resolved value
    // for that field. Match end-of-string OR a separator character so the
    // assertion isn't fooled by `agent-tempo` being a substring of
    // `agent-tempo-dev` (the dev task queue).
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

describe('formatDevBanner — source-annotated diagnostic banner (#423 PR-A)', () => {
  // The architect's `dev-mode-isolation-fix-423.md` example shows
  // `namespace agent-tempo-dev (default) · queue agent-tempo-dev (default)`.
  // The annotation fires for every non-`none` source — including `default` —
  // so the operator never has to ask "is this annotated or not?". Drift
  // (e.g. an env-var leak) becomes a single-character diff in the banner.

  it('annotates the default-source namespace with "(default)"', () => {
    const banner = stripAnsi(
      formatDevBanner({
        home: '/home/alice/.agent-tempo-dev',
        homedirOverride: '/home/alice',
        namespace: DEV_TEMPORAL_NAMESPACE,
        namespaceSource: 'default',
      }),
    );
    expect(banner).toContain(`namespace ${DEV_TEMPORAL_NAMESPACE} (default)`);
  });

  it('annotates the default-source queue with "(default)"', () => {
    const banner = stripAnsi(
      formatDevBanner({
        home: '/home/alice/.agent-tempo-dev',
        homedirOverride: '/home/alice',
        taskQueue: DEV_TASK_QUEUE,
        taskQueueSource: 'default',
      }),
    );
    expect(banner).toContain(`queue ${DEV_TASK_QUEUE} (default)`);
  });

  it('does NOT annotate when source is unspecified (back-compat for legacy fixtures)', () => {
    const banner = stripAnsi(
      formatDevBanner({
        home: '/home/alice/.agent-tempo-dev',
        homedirOverride: '/home/alice',
        namespace: DEV_TEMPORAL_NAMESPACE,
        taskQueue: DEV_TASK_QUEUE,
      }),
    );
    expect(banner).not.toMatch(/namespace [\w-]+ \(/);
    expect(banner).not.toMatch(/queue [\w-]+ \(/);
  });

  it('annotates with "(flag)" when namespace came from a CLI override', () => {
    const banner = stripAnsi(
      formatDevBanner({
        home: '/home/alice/.agent-tempo-dev',
        homedirOverride: '/home/alice',
        namespace: 'explicit-override',
        namespaceSource: 'flag',
      }),
    );
    expect(banner).toContain('namespace explicit-override (flag) ·');
  });

  it('annotates with "(config)" when namespace came from config.json', () => {
    const banner = stripAnsi(
      formatDevBanner({
        home: '/home/alice/.agent-tempo-dev',
        homedirOverride: '/home/alice',
        namespace: 'my-dev-ns',
        namespaceSource: 'config',
      }),
    );
    expect(banner).toContain('namespace my-dev-ns (config) ·');
  });

  it('annotates the queue with "(env)" when AGENT_TEMPO_TASK_QUEUE is set', () => {
    // Drift indicator for the task-queue path. Env-var override of
    // `AGENT_TEMPO_TASK_QUEUE` is still honored (carve-out for queue is
    // deferred to PR-B per architect Q1) — but the banner makes it
    // visible so an operator chasing "why are my workers polling that
    // queue?" sees the override on first inspection.
    const banner = stripAnsi(
      formatDevBanner({
        home: '/home/alice/.agent-tempo-dev',
        homedirOverride: '/home/alice',
        taskQueue: 'my-custom-queue',
        taskQueueSource: 'env',
      }),
    );
    // `queue` is the last banner field, so no trailing separator. Match
    // end-of-string to confirm the annotation is the very last thing on
    // the line (and to prevent a future field from silently breaking the
    // annotation order).
    expect(banner).toMatch(/queue my-custom-queue \(env\)$/);
  });

  it('full diagnostic banner matches architect spec example', () => {
    // Pin the locked single-line format from
    // `docs/design/dev-mode-isolation-fix-423.md` line 115.
    const banner = stripAnsi(
      formatDevBanner({
        home: '/home/alice/.agent-tempo-dev',
        homedirOverride: '/home/alice',
        namespace: DEV_TEMPORAL_NAMESPACE,
        namespaceSource: 'default',
        taskQueue: DEV_TASK_QUEUE,
        taskQueueSource: 'default',
      }),
    );
    expect(banner).toBe(
      `[DEV MODE] using ~/.agent-tempo-dev · port ${DEV_DAEMON_PORT} · ` +
      `namespace ${DEV_TEMPORAL_NAMESPACE} (default) · ` +
      `queue ${DEV_TASK_QUEUE} (default)`,
    );
  });
});

describe('resolveDevBannerInputs (#423 PR-A)', () => {
  // The new helper bridges `getConfigWithSources` → `formatDevBanner`
  // inputs. A bug here recreates the original "banner says X, daemon
  // connects to Y" drift, so we exercise it directly.
  let savedDev: string | undefined;
  let savedNs: string | undefined;
  let savedQueue: string | undefined;
  let savedEnsemble: string | undefined;

  beforeEach(() => {
    savedDev = process.env[ENV.DEV_MODE];
    savedNs = process.env[ENV.TEMPORAL_NAMESPACE];
    savedQueue = process.env[ENV.TASK_QUEUE];
    savedEnsemble = process.env[ENV.ENSEMBLE];
    process.env[ENV.DEV_MODE] = '1';
    delete process.env[ENV.TEMPORAL_NAMESPACE];
    delete process.env[ENV.TASK_QUEUE];
    process.env[ENV.ENSEMBLE] = 'test-ensemble';
  });

  afterEach(() => {
    const restore = (k: string, v: string | undefined) => {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    };
    restore(ENV.DEV_MODE, savedDev);
    restore(ENV.TEMPORAL_NAMESPACE, savedNs);
    restore(ENV.TASK_QUEUE, savedQueue);
    restore(ENV.ENSEMBLE, savedEnsemble);
  });

  it('resolves namespace + source + queue + queueSource from getConfigWithSources', () => {
    const inputs = resolveDevBannerInputs();
    // After Fix 1's carve-out, dev mode resolves namespace to the dev
    // default with source `default` even if `TEMPORAL_NAMESPACE=default`
    // is exported (gone under the carve-out).
    expect(inputs.namespace).toBe(DEV_TEMPORAL_NAMESPACE);
    expect(inputs.namespaceSource).toBe('default');
    expect(inputs.taskQueue).toBe(DEV_TASK_QUEUE);
    expect(inputs.taskQueueSource).toBe('default');
  });

  it('reflects the carve-out when TEMPORAL_NAMESPACE is set in dev mode', () => {
    // The carve-out is the load-bearing fix — without it, `inputs.namespace`
    // would be `'default'` and the banner would lie about what the daemon
    // is connecting to. Direct guard against regression.
    process.env[ENV.TEMPORAL_NAMESPACE] = 'default';
    const inputs = resolveDevBannerInputs();
    expect(inputs.namespace).toBe(DEV_TEMPORAL_NAMESPACE);
    expect(inputs.namespaceSource).toBe('default');
  });

  it('reports queueSource="env" when AGENT_TEMPO_TASK_QUEUE is set', () => {
    // Task queue env-var path is NOT carved out in PR-A (architect Q1
    // deferred to PR-B), so the env override IS honored. The banner's
    // job is to make the override visible.
    process.env[ENV.TASK_QUEUE] = 'my-custom-queue';
    const inputs = resolveDevBannerInputs();
    expect(inputs.taskQueue).toBe('my-custom-queue');
    expect(inputs.taskQueueSource).toBe('env');
  });
});

describe('devBannerOrEmpty', () => {
  let saved: string | undefined;
  let savedEnsemble: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV.DEV_MODE];
    savedEnsemble = process.env[ENV.ENSEMBLE];
    // `devBannerOrEmpty` now resolves through `getConfigWithSources`,
    // which calls into `validateEnsembleName`. Pin a known-good ensemble
    // so the test isn't fooled by the developer's shell config.
    process.env[ENV.ENSEMBLE] = 'test-ensemble';
  });

  afterEach(() => {
    if (saved == null) delete process.env[ENV.DEV_MODE];
    else process.env[ENV.DEV_MODE] = saved;
    if (savedEnsemble == null) delete process.env[ENV.ENSEMBLE];
    else process.env[ENV.ENSEMBLE] = savedEnsemble;
  });

  it('returns empty string when dev mode is off (gate-1 negative case)', () => {
    delete process.env[ENV.DEV_MODE];
    expect(devBannerOrEmpty()).toBe('');
  });

  it('returns the formatted banner when dev mode is on', () => {
    process.env[ENV.DEV_MODE] = '1';
    expect(stripAnsi(devBannerOrEmpty())).toContain('[DEV MODE]');
  });

  it('reflects the resolved namespace value (#423 PR-A drift guard)', () => {
    // After the env-var carve-out from Fix 1, the banner must show the
    // dev default namespace — not whatever was exported in the user's
    // shell.
    process.env[ENV.DEV_MODE] = '1';
    process.env[ENV.TEMPORAL_NAMESPACE] = 'default';
    const banner = stripAnsi(devBannerOrEmpty());
    expect(banner).toContain(`namespace ${DEV_TEMPORAL_NAMESPACE}`);
    // And NOT the prod default that leaked from the shell — full word
    // match, since `default` is a substring of legitimate values.
    expect(banner).not.toMatch(/namespace default(?:\s|·|$)/);
  });
});
