/**
 * Hosts screen — Screen I of the dashboard design (PR-6 of #340).
 * Read-only list of every daemon (host) currently polling this Temporal
 * namespace, joined with their boot-signaled capability profiles.
 *
 * Source: `GET /v1/hosts` via {@link useHosts}.
 *
 * Testability:
 *   - `data-testid="screen-hosts"` on the root
 *   - `data-testid="host-row-${hostname}"` per host
 *   - Loading + error states per the standard convention
 */
import { useEffect } from 'react';
import { useHosts } from '../lib/queries';
import { logEvent } from '../lib/log';
import {
  emptyCardStyle,
  errorPanelStyle,
  monoStyle,
  rowCardStyle,
} from '../lib/screen-styles';

export function Hosts() {
  useEffect(() => { logEvent('screen.opened', { screen: 'hosts' }); }, []);
  const hosts = useHosts();

  if (hosts.isLoading) {
    return (
      <Layout>
        <div
          data-testid="loading"
          data-resource="hosts"
          className="dim"
          style={{ padding: 'var(--density-pad)' }}
        >
          Loading hosts…
        </div>
      </Layout>
    );
  }
  if (hosts.isError) {
    return (
      <Layout>
        <div
          role="alert"
          data-testid="error-hosts"
          style={errorPanelStyle}
        >
          {hosts.error?.message ?? 'Failed to load hosts'}
        </div>
      </Layout>
    );
  }

  const list = hosts.data ?? [];
  if (list.length === 0) {
    return (
      <Layout>
        <div
          data-testid="hosts-empty"
          className="dim"
          style={emptyCardStyle}
        >
          No daemons reporting. Run <code style={monoStyle}>claude-tempo daemon start</code> on a host.
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {list.map((h) => (
          <article
            key={h.hostname}
            data-testid={`host-row-${h.hostname}`}
            data-freshness={h.freshness}
            style={rowCardStyle}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0, fontFamily: 'var(--ff-display)', fontSize: 16, fontWeight: 500 }}>
                {h.hostname}
              </h3>
              <span
                data-testid={`host-row-${h.hostname}-freshness`}
                style={{ ...monoStyle, fontSize: 11, color: freshnessColor(h.freshness) }}
              >
                {h.freshness}
              </span>
            </div>
            <dl style={kvStyle}>
              {h.profile?.version && (
                <KvRow k="version" v={h.profile.version} testId={`host-row-${h.hostname}-version`} />
              )}
              {h.profile?.platform && (
                <KvRow k="platform" v={h.profile.platform} testId={`host-row-${h.hostname}-platform`} />
              )}
              {h.profile?.defaultAgent && (
                <KvRow k="default agent" v={h.profile.defaultAgent} testId={`host-row-${h.hostname}-agent`} />
              )}
              {h.instances?.length ? (
                <KvRow
                  k="instances"
                  v={String(h.instances.length)}
                  testId={`host-row-${h.hostname}-instance-count`}
                />
              ) : null}
              {h.recruitReady !== undefined && (
                <KvRow
                  k="recruit ready"
                  v={String(h.recruitReady)}
                  testId={`host-row-${h.hostname}-recruit-ready`}
                />
              )}
            </dl>
          </article>
        ))}
      </div>
    </Layout>
  );
}

function freshnessColor(f: string | undefined): string {
  if (f === 'live') return 'var(--ok)';
  if (f === 'stale') return 'var(--warn)';
  return 'var(--dim)';
}

function KvRow({ k, v, testId }: { k: string; v: string; testId: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 13 }}>
      <dt className="dim" style={{ minWidth: 100 }}>{k}</dt>
      <dd data-testid={testId} style={{ margin: 0, ...monoStyle }}>{v}</dd>
    </div>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <section
      data-testid="screen-hosts"
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <h1 style={{ marginTop: 0, fontFamily: 'var(--ff-display)', fontSize: 24, fontWeight: 400 }}>
        Hosts
      </h1>
      {children}
    </section>
  );
}

const kvStyle: React.CSSProperties = {
  margin: 0, display: 'flex', flexDirection: 'column', gap: 2,
};
