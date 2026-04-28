/**
 * EnsembleSwitcher — covers the rev 4 acceptance: "opens / dismisses via
 * scrim or close." Plus row select + new-ensemble routing + active-row
 * highlight.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { EnsembleSwitcher } from '../src/components/EnsembleSwitcher';
import { MockDashboardClient } from './fixtures/mock-client';
import { __setDashboardClientForTests } from '../src/lib/client-singleton';
import { renderInRouter } from './render-utils';

const newQc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** Probe so we can assert navigation targets. */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location-probe">{loc.pathname}</div>;
}

function renderSwitcher(opts: {
  client?: MockDashboardClient;
  open?: boolean;
  onClose?: () => void;
  activeEnsemble?: string;
  initialEntry?: string;
}) {
  __setDashboardClientForTests(opts.client ?? new MockDashboardClient({ ensembles: [] }));
  return renderInRouter(
    opts.initialEntry ?? '/',
    <>
      <EnsembleSwitcher
        open={opts.open ?? true}
        onClose={opts.onClose ?? (() => {})}
        activeEnsemble={opts.activeEnsemble}
      />
      <LocationProbe />
    </>,
    {
      wrapper: (children) => (
        <QueryClientProvider client={newQc()}>{children}</QueryClientProvider>
      ),
    },
  );
}

afterEach(() => __setDashboardClientForTests(null));

describe('EnsembleSwitcher', () => {
  it('renders nothing when open=false', () => {
    renderSwitcher({ open: false });
    expect(screen.queryByTestId('ensemble-switcher')).toBeNull();
  });

  it('renders a row per ensemble + the new-ensemble footer when open', async () => {
    const client = new MockDashboardClient({
      ensembles: [
        { name: 'my-band', playerCount: 3, hasConductor: true },
        { name: 'backend', playerCount: 0, hasConductor: false },
      ],
    });
    renderSwitcher({ client });
    expect(await screen.findByTestId('ensemble-switcher')).toBeInTheDocument();
    expect(await screen.findByTestId('ensemble-switcher-row-my-band')).toBeInTheDocument();
    expect(screen.getByTestId('ensemble-switcher-row-backend')).toBeInTheDocument();
    expect(screen.getByTestId('ensemble-switcher-new')).toBeInTheDocument();
  });

  it('renders empty state when no ensembles exist', async () => {
    renderSwitcher({ client: new MockDashboardClient({ ensembles: [] }) });
    expect(await screen.findByTestId('ensemble-switcher-empty')).toBeInTheDocument();
  });

  it('highlights the active row with is-active class + ✓ glyph', async () => {
    const client = new MockDashboardClient({
      ensembles: [
        { name: 'my-band', playerCount: 3, hasConductor: true },
        { name: 'backend', playerCount: 0, hasConductor: false },
      ],
    });
    renderSwitcher({ client, activeEnsemble: 'my-band' });
    const activeRow = await screen.findByTestId('ensemble-switcher-row-my-band');
    expect(activeRow).toHaveClass('is-active');
    expect(activeRow).toHaveTextContent('✓');
    const otherRow = screen.getByTestId('ensemble-switcher-row-backend');
    expect(otherRow).not.toHaveClass('is-active');
  });

  it('fires onClose when the scrim is clicked', () => {
    const onClose = vi.fn();
    renderSwitcher({ onClose });
    fireEvent.click(screen.getByTestId('ensemble-switcher'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onClose when the sheet body is clicked', () => {
    const onClose = vi.fn();
    renderSwitcher({ onClose });
    fireEvent.click(screen.getByTestId('ensemble-switcher-sheet'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('fires onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    renderSwitcher({ onClose });
    fireEvent.click(screen.getByTestId('ensemble-switcher-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('navigates to /ensemble/:name and closes when a row is selected', async () => {
    const client = new MockDashboardClient({
      ensembles: [{ name: 'my-band', playerCount: 3, hasConductor: true }],
    });
    const onClose = vi.fn();
    renderSwitcher({ client, onClose });
    const row = await screen.findByTestId('ensemble-switcher-row-my-band');
    fireEvent.click(row);
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/ensemble/my-band');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('navigates to /create-ensemble and closes when "+ New ensemble" is tapped', () => {
    const onClose = vi.fn();
    renderSwitcher({ onClose });
    fireEvent.click(screen.getByTestId('ensemble-switcher-new'));
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/create-ensemble');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
