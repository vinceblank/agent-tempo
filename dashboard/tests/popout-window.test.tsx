/**
 * PopoutWindow + ChatStub primitives — chrome rendering, close-on-traffic-
 * light-red, non-modal ARIA semantics, and the dock-back affordance on the
 * stub.
 *
 * Canvas v=49 sync: the dimmed scrim is gone; the window is a true
 * always-on-top floating peer. ARIA role flipped from `dialog` to
 * `region` to reflect the non-modal metaphor.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PopoutWindow } from '../src/components/chat/PopoutWindow';
import { ChatStub } from '../src/components/chat/ChatStub';

describe('PopoutWindow primitive', () => {
  it('renders the macOS chrome (3 traffic lights + title + always-on-top hint)', () => {
    const { container } = render(
      <PopoutWindow titleAccent="@my-band">
        <div data-testid="popout-body">body</div>
      </PopoutWindow>,
    );
    expect(screen.getByTestId('popout-window')).toBeInTheDocument();
    expect(screen.getByTestId('popout-window-close')).toBeInTheDocument();
    expect(container.querySelectorAll('.popout-dot').length).toBe(3);
    const title = container.querySelector('.popout-title');
    expect(title?.textContent).toContain('claude-tempo');
    expect(title?.textContent).toContain('@my-band');
    const right = container.querySelector('.popout-right');
    expect(right?.textContent).toContain('always on top');
    expect(screen.getByTestId('popout-body')).toBeInTheDocument();
  });

  it('exposes role="region" with an accessible label (non-modal floating)', () => {
    render(<PopoutWindow />);
    const region = screen.getByRole('region', { name: /popped-out maestro chat/i });
    expect(region).toBeInTheDocument();
    expect(region).toHaveAttribute('data-testid', 'popout-window');
    // Canvas v=49 sync: must NOT be role="dialog" — popout is non-modal.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not render a scrim element (canvas v=49 sync)', () => {
    render(<PopoutWindow />);
    expect(screen.queryByTestId('popout-window-scrim')).toBeNull();
  });

  it('calls onClose when the red traffic-light dot is clicked', () => {
    const onClose = vi.fn();
    render(<PopoutWindow onClose={onClose} />);
    fireEvent.click(screen.getByTestId('popout-window-close'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not propagate clicks from inside the window to the workspace beneath', () => {
    const onClose = vi.fn();
    render(
      <PopoutWindow onClose={onClose}>
        <button type="button" data-testid="inside">click me</button>
      </PopoutWindow>,
    );
    fireEvent.click(screen.getByTestId('inside'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('ChatStub primitive', () => {
  it('renders the docked-stub default copy', () => {
    render(<ChatStub />);
    const stub = screen.getByTestId('chat-stub');
    expect(stub.textContent).toContain('Maestro chat is popped out');
    expect(stub.textContent).toContain('dock it back');
  });

  it('fires onClick when clicked', () => {
    const onClick = vi.fn();
    render(<ChatStub onClick={onClick} />);
    fireEvent.click(screen.getByTestId('chat-stub'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('fires onClick when Enter or Space is pressed (keyboard accessibility)', () => {
    const onClick = vi.fn();
    render(<ChatStub onClick={onClick} />);
    const stub = screen.getByTestId('chat-stub');
    fireEvent.keyDown(stub, { key: 'Enter' });
    fireEvent.keyDown(stub, { key: ' ' });
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('renders custom title + subtitle when provided', () => {
    render(<ChatStub title="Custom title" subtitle="Custom sub" />);
    const stub = screen.getByTestId('chat-stub');
    expect(stub.textContent).toContain('Custom title');
    expect(stub.textContent).toContain('Custom sub');
  });
});
