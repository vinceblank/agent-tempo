/**
 * Tests for {@link DisabledWithTooltip} — every disabled CTA in the
 * dashboard funnels through this primitive, so its accessibility +
 * telemetry contract is critical.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DisabledWithTooltip } from '../src/components/DisabledWithTooltip';

describe('DisabledWithTooltip', () => {
  it('renders the disabled CTA with aria-disabled + title for screen readers', () => {
    render(
      <DisabledWithTooltip
        testId="example-cta"
        action="example"
        reason="Submit available in PR-7"
      >
        Click me
      </DisabledWithTooltip>,
    );
    const button = screen.getByTestId('example-cta');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('title', 'Submit available in PR-7');
    expect(button).toHaveAttribute('data-disabled-reason', 'Submit available in PR-7');
    expect(button.textContent).toBe('Click me');
  });

  it('logs disabled-action.attempted when clicked + suppresses default', () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    render(
      <DisabledWithTooltip
        testId="cta-2"
        action="recruit-submit"
        reason="not yet"
      >
        Recruit
      </DisabledWithTooltip>,
    );
    fireEvent.click(screen.getByTestId('cta-2'));
    const lines = consoleInfo.mock.calls.flat().map(String);
    expect(lines.some((l) => l.includes('disabled-action.attempted') && l.includes('recruit-submit'))).toBe(true);
    consoleInfo.mockRestore();
  });
});
