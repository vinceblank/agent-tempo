import { useEffect } from 'react';
import { AppShell } from './components/AppShell';
import { logEvent } from './lib/log';

export function App() {
  useEffect(() => {
    logEvent('app-mounted', { pr: 'pr-2', issue: '#340' });
  }, []);
  return (
    <AppShell>
      <section
        data-testid="placeholder-content"
        style={{
          padding: 'var(--density-pad)',
          background: 'var(--bg-1)',
          border: '1px solid var(--rule)',
          borderRadius: 8,
        }}
      >
        <h2 style={{ marginTop: 0, fontFamily: 'var(--ff-display)', fontSize: 20, fontWeight: 400 }}>
          Scaffold ready
        </h2>
        <p className="dim" style={{ marginBottom: 0 }}>
          Vite + Tailwind 4 + React 19 are wired. Real screens (Overview,
          Workspace, Player Detail) land in PR-4 once <code>TempoClient</code>{' '}
          browser-mode is integrated. Today this view exists so the design
          tokens, density controls, theme toggle, and{' '}
          <code>logEvent</code> wrapper can be exercised end-to-end.
        </p>
      </section>
    </AppShell>
  );
}
