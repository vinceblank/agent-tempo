/**
 * PhoneAppBar — covers the rev 4 acceptance: "renders sample ensemble +
 * status." Plus active-button highlight + custom action icon.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PhoneAppBar } from '../src/components/PhoneAppBar';

describe('PhoneAppBar', () => {
  it('renders the active ensemble + lineup kicker', () => {
    render(<PhoneAppBar activeEnsemble="my-band" lineup="tempo-dev-team" />);
    expect(screen.getByTestId('phone-appbar')).toBeInTheDocument();
    expect(screen.getByText('lineup · tempo-dev-team')).toBeInTheDocument();
    expect(screen.getByText('my-band')).toBeInTheDocument();
    // The `@` glyph is its own span so the terracotta tint applies.
    expect(screen.getByText('@')).toBeInTheDocument();
  });

  it('falls back to em-dash when no ensemble is set', () => {
    render(<PhoneAppBar />);
    expect(screen.getByText('—')).toBeInTheDocument();
    // No lineup → kicker reads "ensemble" so the row never collapses.
    expect(screen.getByText('ensemble')).toBeInTheDocument();
  });

  it('renders the optional 4-pill status row when status prop is supplied', () => {
    render(
      <PhoneAppBar
        activeEnsemble="my-band"
        status={{ active: 3, idle: 2, detached: 1, uptime: '12m' }}
      />,
    );
    const status = screen.getByTestId('phone-appbar-status');
    expect(status).toHaveTextContent('3 active');
    expect(status).toHaveTextContent('2 idle');
    expect(status).toHaveTextContent('1 detached');
    expect(status).toHaveTextContent('up 12m');
  });

  it('omits the status row entirely when status is undefined', () => {
    render(<PhoneAppBar activeEnsemble="my-band" />);
    expect(screen.queryByTestId('phone-appbar-status')).toBeNull();
  });

  it('omits the detached pill when detached count is 0', () => {
    render(
      <PhoneAppBar
        activeEnsemble="my-band"
        status={{ active: 3, idle: 2, detached: 0 }}
      />,
    );
    const status = screen.getByTestId('phone-appbar-status');
    expect(status).not.toHaveTextContent('detached');
  });

  it('fires onMenu when the hamburger is tapped', () => {
    const onMenu = vi.fn();
    render(<PhoneAppBar activeEnsemble="my-band" onMenu={onMenu} />);
    fireEvent.click(screen.getByTestId('phone-appbar-menu'));
    expect(onMenu).toHaveBeenCalledTimes(1);
  });

  it('fires onAction when the right button is tapped + applies is-active class', () => {
    const onAction = vi.fn();
    render(
      <PhoneAppBar
        activeEnsemble="my-band"
        onAction={onAction}
        actionActive
        actionLabel="Toggle roster"
      />,
    );
    const btn = screen.getByTestId('phone-appbar-action');
    expect(btn).toHaveClass('is-active');
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(btn).toHaveAttribute('aria-label', 'Toggle roster');
    fireEvent.click(btn);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('renders a custom actionIcon when provided', () => {
    render(
      <PhoneAppBar
        activeEnsemble="my-band"
        actionIcon={<span data-testid="custom-action-icon">★</span>}
      />,
    );
    expect(screen.getByTestId('custom-action-icon')).toBeInTheDocument();
  });
});
