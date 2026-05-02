/**
 * UnreadBadge unit tests — commit 2 of feat/chat-notification-system.
 *
 * Pure presentational component; no provider needed.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { UnreadBadge } from '../../src/components/notifications/UnreadBadge';

describe('UnreadBadge', () => {
  it('renders nothing when count is 0 and dotOnly is false', () => {
    const { container, queryByTestId } = render(<UnreadBadge count={0} />);
    expect(queryByTestId('unread-badge')).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a soft .notif-dot when count is 0 and dotOnly is true', () => {
    const { getByTestId } = render(<UnreadBadge count={0} dotOnly />);
    const el = getByTestId('unread-badge');
    expect(el).toHaveClass('notif-dot');
    expect(el).toHaveAttribute('aria-label', 'unread');
    expect(el.textContent).toBe('');
  });

  it('renders a numeric .notif-badge pill for count > 0', () => {
    const { getByTestId } = render(<UnreadBadge count={3} />);
    const el = getByTestId('unread-badge');
    expect(el).toHaveClass('notif-badge');
    expect(el.textContent).toBe('3');
    expect(el).toHaveAttribute('aria-label', '3 unread');
  });

  it('clamps display to "99+" for counts greater than 99', () => {
    const { getByTestId } = render(<UnreadBadge count={150} />);
    const el = getByTestId('unread-badge');
    expect(el.textContent).toBe('99+');
    // aria-label still surfaces the real count for screen readers.
    expect(el).toHaveAttribute('aria-label', '150 unread');
  });

  it('renders the boundary case of count = 99 as "99"', () => {
    const { getByTestId } = render(<UnreadBadge count={99} />);
    expect(getByTestId('unread-badge').textContent).toBe('99');
  });

  it('still renders the numeric pill (not the dot) when count > 0 even with dotOnly', () => {
    const { getByTestId } = render(<UnreadBadge count={5} dotOnly />);
    const el = getByTestId('unread-badge');
    expect(el).toHaveClass('notif-badge');
    expect(el).not.toHaveClass('notif-dot');
    expect(el.textContent).toBe('5');
  });
});
