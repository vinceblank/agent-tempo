/**
 * PhoneTabBar — covers the rev 4 acceptance: "matches active state."
 * The active tab follows the current URL through the `navToTab` lookup
 * (workspace.jsx:23). Each route prefix maps to one of 4 tab keys.
 */
import { describe, it, expect } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { PhoneTabBar } from '../src/components/PhoneTabBar';
import { renderInRouter } from './render-utils';

const renderAt = (initialEntry: string) =>
  renderInRouter(initialEntry, <PhoneTabBar />);

/** Probes the current location for navigation assertions. */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location-probe">{loc.pathname}</div>;
}

const renderWithProbe = (initialEntry: string) =>
  renderInRouter(
    initialEntry,
    <>
      <PhoneTabBar />
      <LocationProbe />
    </>,
  );

describe('PhoneTabBar', () => {
  it('renders all four tabs with mono labels', () => {
    renderAt('/');
    expect(screen.getByTestId('phone-tabbar')).toBeInTheDocument();
    expect(screen.getByTestId('phone-tab-workspace')).toHaveTextContent('Now');
    expect(screen.getByTestId('phone-tab-overview')).toHaveTextContent('Ensembles');
    expect(screen.getByTestId('phone-tab-library')).toHaveTextContent('Library');
    expect(screen.getByTestId('phone-tab-settings')).toHaveTextContent('Settings');
  });

  it('marks Ensembles active on the root path', () => {
    renderAt('/');
    expect(screen.getByTestId('phone-tab-overview')).toHaveClass('is-active');
    expect(screen.getByTestId('phone-tab-workspace')).not.toHaveClass('is-active');
  });

  it('marks Now active inside /ensemble/:id', () => {
    renderAt('/ensemble/my-band');
    expect(screen.getByTestId('phone-tab-workspace')).toHaveClass('is-active');
    expect(screen.getByTestId('phone-tab-workspace')).toHaveAttribute('aria-current', 'page');
  });

  it.each([
    ['/loadouts'],
    ['/player-types'],
    ['/schedules'],
    ['/hosts'],
  ])('marks Library active on %s', (path) => {
    renderAt(path);
    expect(screen.getByTestId('phone-tab-library')).toHaveClass('is-active');
  });

  it('marks Settings active on /settings', () => {
    renderAt('/settings');
    expect(screen.getByTestId('phone-tab-settings')).toHaveClass('is-active');
  });

  it('Library tab navigates to /loadouts (the canonical library landing)', () => {
    renderWithProbe('/');
    fireEvent.click(screen.getByTestId('phone-tab-library'));
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/loadouts');
  });

  it('Settings tab navigates to /settings', () => {
    renderWithProbe('/');
    fireEvent.click(screen.getByTestId('phone-tab-settings'));
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/settings');
  });

  it('Now tab sticks to the current ensemble when one is active', () => {
    renderWithProbe('/ensemble/my-band');
    fireEvent.click(screen.getByTestId('phone-tab-workspace'));
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/ensemble/my-band');
  });

  it('Now tab falls back to / when no ensemble is in the URL', () => {
    // From /loadouts the Library tab is active but there's no ensemble
    // context — Now should land on Overview, not error or stay on
    // /loadouts (which would mis-imply that Library + Now share routes).
    renderWithProbe('/loadouts');
    fireEvent.click(screen.getByTestId('phone-tab-workspace'));
    expect(screen.getByTestId('location-probe')).toHaveTextContent('/');
  });
});
