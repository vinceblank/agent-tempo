/**
 * Overview screen — Screen C of the dashboard design (PR-4 of #340).
 *
 * Lists every running ensemble; each card streams live state via SSE.
 * The first screen the dashboard renders, and the only screen with real
 * content in PR-4 — the rest stub out with `<PlaceholderScreen />` until
 * PR-5/6.
 *
 * Testability surface:
 *   - `data-testid="screen-overview"` on the root
 *   - `data-testid="loading" data-resource="ensemble-list"` while loading
 *   - `role="alert" data-testid="error-ensemble-list"` on error
 *   - `data-testid="overview-empty"` when no ensembles are live
 *   - per-card testids documented in `EnsembleCard.tsx`
 */
import { useEnsembleList } from '../lib/queries';
import { EnsembleCard } from '../components/EnsembleCard';

export function Overview() {
  const list = useEnsembleList();

  if (list.isLoading) {
    return (
      <section
        data-testid="screen-overview"
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <h1 style={{ marginTop: 0, fontFamily: 'var(--ff-display)', fontSize: 24, fontWeight: 400 }}>
          Ensembles
        </h1>
        <div
          data-testid="loading"
          data-resource="ensemble-list"
          className="dim"
          style={{ padding: 'var(--density-pad)' }}
        >
          Loading ensembles…
        </div>
      </section>
    );
  }

  if (list.isError) {
    return (
      <section data-testid="screen-overview">
        <h1 style={{ marginTop: 0, fontFamily: 'var(--ff-display)', fontSize: 24, fontWeight: 400 }}>
          Ensembles
        </h1>
        <div
          role="alert"
          data-testid="error-ensemble-list"
          style={{
            padding: 'var(--density-pad)',
            background: 'var(--bg-1)',
            border: '1px solid var(--accent)',
            borderRadius: 8,
            color: 'var(--accent)',
          }}
        >
          {list.error?.message ?? 'Failed to load ensembles'}
        </div>
      </section>
    );
  }

  const ensembles = list.data ?? [];

  return (
    <section
      data-testid="screen-overview"
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <h1 style={{ marginTop: 0, fontFamily: 'var(--ff-display)', fontSize: 24, fontWeight: 400 }}>
        Ensembles
      </h1>
      {ensembles.length === 0 ? (
        <div
          data-testid="overview-empty"
          className="dim"
          style={{
            padding: 'var(--density-pad)',
            background: 'var(--bg-1)',
            border: '1px dashed var(--rule)',
            borderRadius: 8,
          }}
        >
          No ensembles are running. Open a terminal and run{' '}
          <code style={{ fontFamily: 'var(--ff-mono)' }}>claude-tempo up &lt;name&gt;</code>{' '}
          to start one.
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: 12,
          }}
        >
          {ensembles.map((e) => (
            <EnsembleCard key={e.name} ensemble={e} />
          ))}
        </div>
      )}
    </section>
  );
}
